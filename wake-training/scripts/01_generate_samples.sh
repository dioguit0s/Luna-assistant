#!/bin/bash
# Gera amostras sintéticas de "hey luna" com o Piper (voz libritts). São a base
# positiva do treino — o "target_word" do notebook oficial do microWakeWord.
set -euo pipefail

TARGET_WORD="${TARGET_WORD:-hey luna}"
MAX_SAMPLES="${MAX_SAMPLES:-2000}"
BATCH_SIZE="${BATCH_SIZE:-100}"
OUT_DIR="/work/generated_samples"

mkdir -p "$OUT_DIR"

echo "[1/1] Gerando $MAX_SAMPLES amostras de '$TARGET_WORD' em $OUT_DIR ..."
python3 -m piper_sample_generator "$TARGET_WORD" \
  --model /opt/piper-sample-generator/models/en_US-libritts_r-medium.pt \
  --max-samples "$MAX_SAMPLES" \
  --batch-size "$BATCH_SIZE" \
  --output-dir "$OUT_DIR"

echo "Amostras geradas: $(ls "$OUT_DIR"/*.wav 2>/dev/null | wc -l)"
