#!/bin/bash
# Baixa os datasets negativos pré-processados (features já em espectrograma)
# publicados pelo autor do microWakeWord — célula 8 do notebook oficial.
set -euo pipefail

OUT_DIR="/work/negative_datasets"
mkdir -p "$OUT_DIR"

LINK_ROOT="https://huggingface.co/datasets/kahrendt/microwakeword/resolve/main/"
FILES=(dinner_party.zip dinner_party_eval.zip no_speech.zip speech.zip)

for fname in "${FILES[@]}"; do
  name="${fname%.zip}"
  if [ -d "$OUT_DIR/$name" ]; then
    echo "[$name] já existe, pulando"
    continue
  fi
  echo "[$name] baixando ..."
  wget -q --show-progress -O "$OUT_DIR/$fname" "${LINK_ROOT}${fname}"
  echo "[$name] extraindo ..."
  unzip -q "$OUT_DIR/$fname" -d "$OUT_DIR"
  rm -f "$OUT_DIR/$fname"
done

echo "Concluído: $(ls "$OUT_DIR")"
