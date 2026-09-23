#!/bin/bash
# Orquestra o pipeline inteiro de treino do "Hey Luna" (microWakeWord).
# Cada etapa é resumível: se já existir a saída, o script da etapa pula.
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

run() {
  echo "=== $1 ==="
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$WORK:/work" \
    -v "$SCRIPTS:/scripts" \
    "$IMAGE" "${@:2}"
}

step_samples()    { run "1/7 amostras TTS"        bash /scripts/01_generate_samples.sh; }
step_augdata()     { run "2/7 dados de augmentation" python3 /scripts/02_download_augmentation.py; }
step_features()    { run "3/7 espectrogramas"       python3 /scripts/03_generate_features.py; }
step_negatives()   { run "4/7 negativos"            bash /scripts/04_download_negatives.sh; }
# Opcional: só gera algo se houver WAVs em work/custom_negatives_wav/ — ver
# "Se o modelo dispara demais" no README. Roda sempre (é barata e no-op
# quando vazia) para não exigir mais um passo manual em "all".
step_custom_negatives() { run "4b/7 negativos pt-BR (opcional)" python3 /scripts/04b_generate_custom_negatives.py; }
step_train()       {
  run "5/7 config de treino" python3 /scripts/05_write_training_config.py
  run "5/7 treino (demorado)" bash /scripts/06_train.sh
}
step_export()      { run "6/7 exportar manifesto" python3 /scripts/07_export_manifest.py; }

case "${1:-all}" in
  samples) step_samples ;;
  augdata) step_augdata ;;
  features) step_features ;;
  negatives) step_negatives ;;
  custom_negatives) step_custom_negatives ;;
  train) step_train ;;
  export) step_export ;;
  all)
    step_samples
    step_augdata
    step_negatives
    step_custom_negatives
    step_features
    step_train
    step_export
    ;;
  *)
    echo "Uso: $0 [samples|augdata|features|negatives|custom_negatives|train|export|all]" >&2
    exit 1
    ;;
esac
