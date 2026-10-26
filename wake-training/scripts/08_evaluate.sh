#!/bin/bash
# Mede o modelo recém-treinado contra o que está no firmware, no áudio que
# NENHUM dos dois viu no treino — ver "Critério de aceite" no README. Roda o
# luna-desktop/wakeword-sidecar/evaluate.py (montado em /sidecar pelo run.sh),
# o mesmo caminho de features/inferência do sidecar e do WakeWord.cpp.
#
# Entra o que existir:
#   positivos: hold-out das gravações reais (03b) e o fixtures/hey-luna.wav (11x);
#   negativos: tudo em work/eval_negatives/<conjunto>/ — FLEURS dev/test (04d),
#              frases confundíveis do hold-out do 04c e gravações próprias que
#              você colocar lá (TV, conversa da casa) SEM pôr também em
#              custom_negatives_wav/ — e o fixtures/okay-nabu.wav.
# EVAL_BASELINE troca o modelo de comparação (nome do .tflite em
# luna-firmware/models/); EVAL_ARGS repassa flags extras ao evaluate.py.
set -euo pipefail
cd /work

BASELINE="${EVAL_BASELINE:-hey_luna_ptbr.tflite}"
args=()
[ -f hey_luna.tflite ] && args+=(--model /work/hey_luna.tflite)
[ -f "/models/$BASELINE" ] && args+=(--model "/models/$BASELINE")
if [ ${#args[@]} = 0 ]; then
  echo "nenhum modelo para avaliar (nem work/hey_luna.tflite nem /models/$BASELINE)" >&2
  exit 1
fi

[ -d real_positives_clips/holdout ] && args+=(--positive /work/real_positives_clips/holdout)
args+=(--positive /sidecar/fixtures/hey-luna.wav:11)
if [ -d eval_negatives ]; then
  for d in eval_negatives/*/; do
    [ -d "$d" ] && args+=(--negative "/work/${d%/}")
  done
fi
args+=(--negative /sidecar/fixtures/okay-nabu.wav)

read -ra extra <<< "${EVAL_ARGS:-}"
PYTHONDONTWRITEBYTECODE=1 python3 /sidecar/evaluate.py "${args[@]}" \
  --top-cutoff 0.99 --json /work/eval_report.json ${extra[@]+"${extra[@]}"}
