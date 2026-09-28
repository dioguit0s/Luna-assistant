#!/bin/bash
# Orquestra o pipeline inteiro de treino do "Hey Luna" (microWakeWord).
# Cada etapa é resumível: se já existir a saída, o script da etapa pula
# (exceto custom_negatives e real_positives, que sempre regeneram a partir dos
# áudios de entrada, e train, que retoma da última rodada concluída).
#
# Uso:
#   ./run.sh                 # roda tudo, na ordem
#   ./run.sh samples         # roda só uma etapa
#
# Todos os dados ficam em ./work (fora do git, ver .gitignore) — montado como
# /work dentro do container, então nada cai no C: nem no disco do Docker.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=mww-train
WORK="$(pwd)/work"
SCRIPTS="$(pwd)/scripts"
mkdir -p "$WORK"

# Flags extras do `docker run`, ex. MWW_DOCKER_ARGS="--memory=8g --cpus=3".
# Sem --memory, um vazamento do TF no treino (ver 06b_train_loop.sh) cai no
# OOM killer do HOST, que pode escolher outro processo — no servidor de
# produção, o luna-server. Com --memory, morre só o container (código 137) e
# `./run.sh train` retoma do último checkpoint.
read -ra DOCKER_EXTRA <<< "${MWW_DOCKER_ARGS:-}"
# Variáveis de ambiente para o container das chamadas de run() (ex.
# `-e TRAINING_STEPS=500`); o treino em rodadas usa.
RUN_ENV=()

run() {
  echo "=== $1 ==="
  MSYS_NO_PATHCONV=1 docker run --rm ${DOCKER_EXTRA[@]+"${DOCKER_EXTRA[@]}"} ${RUN_ENV[@]+"${RUN_ENV[@]}"} \
    -v "$WORK:/work" \
    -v "$SCRIPTS:/scripts" \
    "$IMAGE" "${@:2}"
}

step_samples()    { run "1/7 amostras TTS"        bash /scripts/01_generate_samples.sh; }
# Vozes Piper pt-BR, nas mesmas generated_samples/ — rodar `features` depois.
step_ptbr_samples() { run "1b/7 amostras TTS pt-BR" python3 /scripts/01b_generate_ptbr_samples.py; }
step_augdata()     { run "2/7 dados de augmentation" python3 /scripts/02_download_augmentation.py; }
step_features()    { run "3/7 espectrogramas"       python3 /scripts/03_generate_features.py; }
step_negatives()   { run "4/7 negativos"            bash /scripts/04_download_negatives.sh; }
# Opcional: só gera algo se houver WAVs em work/custom_negatives_wav/ — ver
# "Se o modelo dispara demais" no README. Roda sempre (no-op quando vazia)
# para não exigir mais um passo manual em "all"; com WAVs, regenera do zero.
step_custom_negatives() { run "4b/7 negativos pt-BR (opcional)" python3 /scripts/04b_generate_custom_negatives.py; }
# Opcional: gravações reais de "hey luna" em work/real_positives_wav/ — ver
# "Positivos reais" no README. No-op sem áudio; com áudio, regenera do zero.
step_real_positives() { run "3b/7 positivos reais (opcional)" python3 /scripts/03b_generate_real_positives.py; }

# Treino em rodadas curtas. Cada validação do model_train_eval vaza ~3,8 GB que
# nunca são liberados: um processo de 5000 passos (10 validações) morre por OOM
# na 3ª, e reiniciá-lo não resolve — o checkpoint de restore/ só é salvo em
# "novo melhor" e a contagem de passos zera. Rodadas de TRAIN_ROUND_STEPS
# passos (1 validação cada, no último passo) terminam sempre, e o processo
# salva o checkpoint no fim; a próxima rodada retoma dali.
#
# TRAIN_ROUND_STEPS precisa ser <= eval_step_interval (500, no 05): com mais,
# a rodada valida mais de uma vez (volta o vazamento) e o best_weights guardado
# deixa de ser o da métrica registrada (a última validação).
#
# O "melhor" do microWakeWord reinicia a cada processo, então best_weights no
# fim seria só a última rodada. Por isso cada rodada guarda seus pesos e sua
# métrica em trained_models/rounds/, e no fim a rodada com maior
# `average viable recall` (a métrica que o próprio microWakeWord maximiza) vira
# best_weights e é convertida em .tflite por 06c_export_only.sh, num processo
# novo (sem a memória vazada).
#
# Retoma da rodada seguinte à última concluída. Para treinar do zero, mova
# work/trained_models/ para outro lugar antes.
TRAIN_ROUNDS="${TRAIN_ROUNDS:-10}"
TRAIN_ROUND_STEPS="${TRAIN_ROUND_STEPS:-500}"
TRAIN_ROUND_RETRIES=3

step_train() {
  local rounds_dir="$WORK/trained_models/rounds"
  local weights="$WORK/trained_models/wakeword/best_weights.weights.h5"
  local r try code log best
  if [ "$TRAIN_ROUND_STEPS" -gt 500 ]; then
    echo "TRAIN_ROUND_STEPS=$TRAIN_ROUND_STEPS > 500 (eval_step_interval): cada rodada validaria mais de uma vez" >&2
    return 1
  fi
  mkdir -p "$rounds_dir"
  # Mostra no console quais conjuntos de features entram — o log de cada rodada
  # fica em arquivo, e um treino sem positivos reais pareceria igual a um com.
  run "5/7 config de treino" python3 /scripts/05_write_training_config.py
  RUN_ENV=(-e "TRAINING_STEPS=$TRAIN_ROUND_STEPS" -e TEST_STREAMING_QUANTIZED=0)
  for r in $(seq 1 "$TRAIN_ROUNDS"); do
    # Retomada: pula rodada já concluída (métrica não vazia registrada).
    [ -s "$rounds_dir/round$r.metric" ] && continue
    for try in $(seq 1 "$TRAIN_ROUND_RETRIES"); do
      log="$rounds_dir/round$r.log"
      code=0
      run "5/7 treino rodada $r/$TRAIN_ROUNDS ($TRAIN_ROUND_STEPS passos, tentativa $try)" \
        bash -c "python3 /scripts/05_write_training_config.py && bash /scripts/06_train.sh" > "$log" 2>&1 || code=$?
      [ "$code" = 0 ] && break
      echo "rodada $r saiu com código $code (log: $log)" >&2
      # 137 = OOM: repete, retomando do último checkpoint. Outro código é bug.
      if [ "$code" != 137 ] || [ "$try" = "$TRAIN_ROUND_RETRIES" ]; then
        RUN_ENV=()
        return 1
      fi
    done
    cp "$weights" "$rounds_dir/round$r.weights.h5"
    tr '\r' '\n' < "$log" | grep -a -o 'average viable recall = [0-9.]*' | tail -1 | awk '{print $NF}' > "$rounds_dir/round$r.metric" || true
    echo "rodada $r: $(tr '\r' '\n' < "$log" | grep -a '(nonstreaming): Validation' | tail -1 | sed 's/.*Validation: //' || true)"
  done
  RUN_ENV=()

  best=$(for f in "$rounds_dir"/round*.metric; do [ -s "$f" ] && echo "$(cat "$f") $(basename "$f" .metric)"; done | sort -g | tail -1)
  if [ -z "$best" ]; then
    echo "nenhuma rodada com métrica em $rounds_dir" >&2
    return 1
  fi
  echo "melhor rodada: ${best#* } (average viable recall ${best%% *})"
  cp "$rounds_dir/${best#* }.weights.h5" "$weights"
  run "5/7 conversão para .tflite (${best#* })" bash /scripts/06c_export_only.sh
}
step_export()      { run "6/7 exportar manifesto" python3 /scripts/07_export_manifest.py; }

case "${1:-all}" in
  samples) step_samples ;;
  augdata) step_augdata ;;
  ptbr_samples) step_ptbr_samples ;;
  features) step_features ;;
  real_positives) step_real_positives ;;
  negatives) step_negatives ;;
  custom_negatives) step_custom_negatives ;;
  train) step_train ;;
  export) step_export ;;
  all)
    step_samples
    step_ptbr_samples
    step_augdata
    step_negatives
    step_custom_negatives
    step_features
    step_real_positives
    step_train
    step_export
    ;;
  *)
    echo "Uso: $0 [samples|ptbr_samples|augdata|features|real_positives|negatives|custom_negatives|train|export|all]" >&2
    exit 1
    ;;
esac
