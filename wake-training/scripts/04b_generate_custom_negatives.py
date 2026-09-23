#!/usr/bin/env python3
"""Gera features de negativos CUSTOMIZADOS (pt-BR) a partir de WAVs fornecidos
pelo humano — passo que os negativos pré-processados do microWakeWord
(`04_download_negatives.sh`, todos em inglês) não cobrem.

Motivação: o modelo treinado só com `speech`/`dinner_party`/`no_speech` (en)
nunca viu frases do dia a dia em português como negativo, então "é a Luna",
"lua", "uma", trechos de TV ou conversa em pt-BR têm mais chance de cruzar o
cutoff por acidente — ver a seção "Se o modelo dispara demais" no README.

Entrada esperada: `/work/custom_negatives_wav/*.wav` — qualquer WAV mono,
qualquer sample rate (o `Clips` do microWakeWord resample sozinho), com fala
em pt-BR: TV, conversa de fundo, e principalmente as palavras/frases
confundíveis com "hey luna" (ex. "lua", "e aí, luna", "uma", "luna" sem o
"hey"). Sem áudio nesse diretório, a etapa é pulada — ela é opcional, ao
contrário das outras (que rodam sempre em `run.sh all`).

Ao contrário de `03_generate_features.py` (que aumenta POSITIVOS com
ruído/reverb via `Augmentation`, célula 5-7 do notebook oficial), aqui os
clipes já são o ambiente real (TV, sala, etc.) — não augmentamos de novo,
só fatiamos em janelas deslizantes como negativo (`truth=False` é decidido
depois, em `05_write_training_config.py`, pela entrada apontar para este
diretório).
"""
import os
import sys

WORK = "/work"
IN_DIR = os.path.join(WORK, "custom_negatives_wav")
OUT_DIR = os.path.join(WORK, "negative_datasets", "custom_ptbr")

os.chdir(WORK)

wavs = [f for f in os.listdir(IN_DIR) if f.endswith(".wav")] if os.path.isdir(IN_DIR) else []
if not wavs:
    print(
        f"[custom_ptbr] nenhum .wav em {IN_DIR} — etapa opcional pulada. "
        "Ver 'Se o modelo dispara demais' no README para gravar os negativos."
    )
    sys.exit(0)

from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

print(f"[custom_ptbr] {len(wavs)} WAV(s) encontrados em {IN_DIR}")

clips = Clips(
    input_directory=IN_DIR,
    file_pattern="*.wav",
    max_clip_duration_s=None,
    remove_silence=False,
    random_split_seed=10,
    split_count=0.1,
)

# Sem Augmentation: os clipes já vêm do ambiente real (mic, TV, conversa) que
# se quer rejeitar — augmentar de novo só dilui o sinal específico que
# importa aqui, que é "essa frase pt-BR não deveria disparar".
spectrograms = SpectrogramGeneration(clips=clips, augmenter=None, slide_frames=10, step_ms=10)

splits = {"training": "train", "validation": "validation", "testing": "test"}
for split, split_name in splits.items():
    out_dir = os.path.join(OUT_DIR, split)
    os.makedirs(out_dir, exist_ok=True)
    repetition = 2 if split == "training" else 1
    print(f"[custom_ptbr/{split}] gerando espectrogramas (split_name={split_name}, repetition={repetition}) ...")
    RaggedMmap.from_generator(
        out_dir=os.path.join(out_dir, "wakeword_mmap"),
        sample_generator=spectrograms.spectrogram_generator(split=split_name, repeat=repetition),
        batch_size=100,
        verbose=True,
    )

print(f"[custom_ptbr] concluído — features em {OUT_DIR}")
