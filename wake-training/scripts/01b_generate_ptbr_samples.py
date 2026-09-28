#!/usr/bin/env python3
"""Gera amostras sintéticas de "hey luna" com vozes Piper em PORTUGUÊS.

Motivação: `01_generate_samples.sh` usa só o gerador `en_US-libritts_r-medium`
(uma única voz em inglês). O retreino de 2026-09-25 mostrou o custo disso: com
todos os positivos vindo dessa voz e toda voz humana real rotulada negativa
(negativos pt-BR), o modelo aprendeu algo como "voz real = não" e acertou 1/10
"hey luna" reais. Vozes pt-BR aproximam os positivos de como a frase é dita em
casa ("rei luna", "ei luna") — complementam as gravações reais de
`03b_generate_real_positives.py`, não as substituem.

As amostras vão para `/work/generated_samples/ptbr_*.wav`, junto das inglesas,
para passarem pela MESMA augmentation/split do `03_generate_features.py` —
rodar `features` de novo depois desta etapa. Idempotente: pula se já houver
as len(VOICES) * PTBR_SAMPLES_PER_VOICE amostras pt-BR; se houver outra
quantidade (execução interrompida, ou PTBR_SAMPLES_PER_VOICE mudou), apaga e
regera todas.

As vozes (.onnx + .json, ~60 MB cada) são baixadas uma vez do repositório
oficial do Piper (rhasspy/piper-voices no HuggingFace) para /work/piper_voices.
"""
import glob
import itertools
import os
import random
import sys
import urllib.request
import wave

WORK = "/work"
VOICES_DIR = os.path.join(WORK, "piper_voices")
OUT_DIR = os.path.join(WORK, "generated_samples")

HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR"
VOICES = ["faber-medium", "cadu-medium", "jeff-medium", "edresson-low"]

# Grafias que o espeak pt-BR pronuncia como as variações reais da frase: o
# "hey" inglês vira "rei"/"ei" na boca de quem fala português.
TEXTS = ["Hey Luna", "Hey, Luna!", "Ei, Luna", "Ei Luna!", "Rei Luna", "Hei, Luna?"]
LENGTH_SCALES = [0.75, 0.9, 1.0, 1.15, 1.3]
NOISE_SCALES = [0.4, 0.667, 0.9]
NOISE_W_SCALES = [0.5, 0.8, 1.1]
SAMPLES_PER_VOICE = int(os.environ.get("PTBR_SAMPLES_PER_VOICE", "120"))
MARGIN_S = 0.05


def trim(pcm: bytes, sr: int) -> bytes:
    """Corta o silêncio das pontas, deixando MARGIN_S de folga — as vozes cadu
    e jeff saem com até ~0,9 s de silêncio antes e ~0,35 s depois, enquanto as
    amostras inglesas vêm com ~0,05 s. Silêncio no fim desloca a palavra para
    longe do fim da janela de augmentation (truncation `truncate_start`)."""
    import numpy as np

    a = np.frombuffer(pcm, dtype=np.int16)
    hop = int(0.01 * sr)
    peaks = np.array([np.abs(a[i:i + hop]).max() for i in range(0, len(a) - hop, hop)])
    if peaks.size == 0 or peaks.max() == 0:
        return pcm  # síntese vazia ou muda: não há o que cortar
    on = np.where(peaks > 0.05 * peaks.max())[0]
    margin = int(MARGIN_S * sr)
    start = max(0, on[0] * hop - margin)
    end = min(len(a), (on[-1] + 1) * hop + margin)
    return a[start:end].tobytes()


os.makedirs(OUT_DIR, exist_ok=True)
existing = glob.glob(os.path.join(OUT_DIR, "ptbr_*.wav"))
expected = len(VOICES) * SAMPLES_PER_VOICE
if len(existing) == expected:
    print(f"[ptbr_samples] {len(existing)} amostras pt-BR já existem em {OUT_DIR} — pulando")
    sys.exit(0)
if existing:
    print(f"[ptbr_samples] {len(existing)} amostras pt-BR (esperadas {expected}) — apagando e regerando")
    for f in existing:
        os.remove(f)

from piper import PiperVoice, SynthesisConfig

os.makedirs(VOICES_DIR, exist_ok=True)
rng = random.Random(10)
total = 0
for name in VOICES:
    speaker, quality = name.rsplit("-", 1)
    base = f"pt_BR-{name}"
    onnx = os.path.join(VOICES_DIR, base + ".onnx")
    for ext in (".onnx", ".onnx.json"):
        dst = os.path.join(VOICES_DIR, base + ext)
        if not os.path.exists(dst):
            url = f"{HF}/{speaker}/{quality}/{base}{ext}"
            print(f"[ptbr_samples] baixando {url}")
            urllib.request.urlretrieve(url, dst + ".part")
            os.rename(dst + ".part", dst)

    voice = PiperVoice.load(onnx)
    combos = list(itertools.product(TEXTS, LENGTH_SCALES, NOISE_SCALES, NOISE_W_SCALES))
    rng.shuffle(combos)
    for i, (text, ls, ns, nw) in enumerate(combos[:SAMPLES_PER_VOICE]):
        cfg = SynthesisConfig(length_scale=ls, noise_scale=ns, noise_w_scale=nw)
        chunks = list(voice.synthesize(text, syn_config=cfg))
        pcm = trim(b"".join(c.audio_int16_bytes for c in chunks), chunks[0].sample_rate)
        out = os.path.join(OUT_DIR, f"ptbr_{name}_{i:04d}.wav")
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(chunks[0].sample_rate)
            w.writeframes(pcm)
        total += 1
    print(f"[ptbr_samples] {name}: {min(len(combos), SAMPLES_PER_VOICE)} amostras")

print(f"[ptbr_samples] {total} amostras pt-BR em {OUT_DIR} — rode `./run.sh features` de novo")
