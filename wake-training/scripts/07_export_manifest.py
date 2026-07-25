#!/usr/bin/env python3
"""Copia o .tflite treinado para a raiz de /work e escreve o manifesto JSON no
mesmo formato dos modelos oficiais (okay_nabu.json etc.) — célula 11 do notebook,
mais o passo de escrever o manifesto que o notebook deixa manual.

Os valores de probability_cutoff/sliding_window_size aqui são PONTO DE PARTIDA,
copiados da convenção da comunidade. Recalibrar de verdade com o firmware:
ligar WAKE_DEBUG (config.h), observar o raw_max/janela-5 no microfone real
falando "hey luna", e então ajustar WAKE_PROB_CUTOFF — foi assim que se
descobriu que o okay_nabu precisa de 0.90, não do 0.97 do manifesto oficial.
"""
import json
import shutil
from pathlib import Path

WORK = Path("/work")
TRAINED_TFLITE = WORK / "trained_models/wakeword/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite"
OUT_TFLITE = WORK / "hey_luna.tflite"
OUT_JSON = WORK / "hey_luna.json"

if not TRAINED_TFLITE.exists():
    raise SystemExit(f"Não encontrei o modelo treinado em {TRAINED_TFLITE}. Rode 06_train.sh até o fim.")

shutil.copy(TRAINED_TFLITE, OUT_TFLITE)
print(f"Copiado: {TRAINED_TFLITE} -> {OUT_TFLITE} ({OUT_TFLITE.stat().st_size} bytes)")

# Best-effort: lê a forma do tensor de entrada para confirmar o stride, sem
# tornar isso um requisito rígido do pipeline (a inspeção manual no host já
# provou isso antes para hey_luna/okay_nabu).
stride = None
try:
    import tflite  # requer `pip install tflite`, não é dependência do microWakeWord

    buf = OUT_TFLITE.read_bytes()
    model = tflite.Model.GetRootAsModel(buf, 0)
    g = model.Subgraphs(0)
    in_tensor = g.Tensors(g.Inputs(0))
    shape = in_tensor.ShapeAsNumpy().tolist()
    print(f"Entrada do modelo: shape={shape} type={in_tensor.Type()}")
    if len(shape) == 3:
        stride = int(shape[1])
except Exception as exc:  # pragma: no cover - só diagnóstico
    print(f"(não consegui inspecionar o tflite automaticamente: {exc})")

manifest = {
    "type": "micro",
    "wake_word": "Hey Luna",
    "author": "treino local (microWakeWord)",
    "website": "https://github.com/kahrendt/microWakeWord",
    "model": "hey_luna.tflite",
    "trained_languages": ["en"],
    "version": 2,
    "micro": {
        "probability_cutoff": 0.97,
        "feature_step_size": 10,
        "sliding_window_size": 5,
        "tensor_arena_size": 34000,
        "minimum_esphome_version": "2024.7.0",
    },
}

with open(OUT_JSON, "w") as f:
    json.dump(manifest, f, indent=2)

print(f"Manifesto escrito em {OUT_JSON}")
if stride is not None:
    print(f"Stride confirmado pelo tensor: {stride} (a FSM do firmware lê isso sozinha no boot)")
print("\nPRÓXIMO PASSO: copiar hey_luna.tflite/.json para luna-firmware/models/,")
print("regerar o header com tools/tflite_to_header.py e testar com WAKE_DEBUG=1.")
