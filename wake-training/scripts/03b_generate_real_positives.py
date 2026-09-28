#!/usr/bin/env python3
"""Gera features de positivos REAIS ("hey luna" gravado por gente de verdade).

Motivação: o retreino de 2026-09-25 acertou 1/10 "hey luna" reais — todos os
positivos vinham de uma voz TTS em inglês e toda voz humana real que o modelo
via estava rotulada negativa. Gravações reais são o que mais aproxima o
positivo do que o microfone vai ouvir.

Entrada: `/work/real_positives_wav/` — qualquer áudio que o soundfile leia
(.wav, .ogg/Opus do WhatsApp, .mp3, .flac), cada arquivo com várias repetições
de "hey luna" separadas por pausas (~1 s). Cada repetição é recortada sozinha
por energia; segmentos curtos/longos demais ou fracos demais são descartados
(ver SEG_*), e o log lista o que ficou de fora para conferir.

Hold-out: 1 de cada HOLDOUT_EVERY repetições de cada arquivo (contadas dentro
do arquivo, para que adicionar uma gravação nova não mude o hold-out das
antigas) NUNCA entra no treino. Vão para
`/work/real_positives_clips/holdout/` e, concatenadas com pausas, para
`/work/real_positives_holdout.wav` (16 kHz mono) — a régua de aceite do modelo
junto do `luna-desktop/wakeword-sidecar/fixtures/hey-luna.wav` (ver README,
"Critério de aceite"). O split validation/testing do microWakeWord não serve
para isso: sai das mesmas gravações e só mede o que o treino já viu.

Features: mesma `Augmentation` do `03_generate_features.py` (ruído, RIR, EQ),
mas com muito mais repetições — são dezenas de clipes, não milhares, e cada
repetição sorteia uma augmentation diferente. Saída em
`/work/real_positive_features/`, gerada num .tmp e renomeada só no fim (mesmo
motivo do 04b: um `*_mmap` vazio quebraria o treino). Sempre regenera; sem
áudio de entrada, apaga a saída antiga e sai.
"""
import os
import shutil
import sys

import numpy as np

WORK = "/work"
IN_DIR = os.path.join(WORK, "real_positives_wav")
CLIPS_DIR = os.path.join(WORK, "real_positives_clips")
OUT_DIR = os.path.join(WORK, "real_positive_features")
TMP_DIR = OUT_DIR + ".tmp"
HOLDOUT_WAV = os.path.join(WORK, "real_positives_holdout.wav")

AUDIO_EXTS = (".wav", ".ogg", ".opus", ".mp3", ".flac")
HOLDOUT_EVERY = 5
# Segmentação por energia em janelas de 20 ms. O limiar fica a 45% do caminho
# entre o piso de ruído (p10) e o pico (p99) do próprio arquivo, então se
# adapta ao ganho de cada gravação.
SEG_HOP_S = 0.02
SEG_THRESHOLD = 0.45
SEG_BRIDGE_S = 0.26   # pausas menores que isto dentro da frase ("hey ... luna") não cortam
SEG_MIN_S = 0.3
SEG_MAX_S = 1.3       # mais que isto costuma ser duas repetições coladas ou outra fala
SEG_MIN_PEAK_DB = 20  # pico a menos de 20 dB do p99 do arquivo = ruído, não fala
SEG_MARGIN_S = 0.08
MIN_TRAIN_CLIPS = 10
# Repetições de augmentation por clipe. Dos clipes de treino, o Clips ainda
# separa 20% para validation/testing: 60 clipes -> ~48 x 25 = ~1200 amostras de
# treino, a mesma ordem de grandeza das 2000 sintéticas.
REPEAT = {"training": 25, "validation": 3, "testing": 3}

os.chdir(WORK)


def clear_outputs():
    for path in (OUT_DIR, TMP_DIR, CLIPS_DIR):
        shutil.rmtree(path, ignore_errors=True)
    if os.path.exists(HOLDOUT_WAV):
        os.remove(HOLDOUT_WAV)


inputs = sorted(
    os.path.join(IN_DIR, f) for f in os.listdir(IN_DIR) if f.lower().endswith(AUDIO_EXTS)
) if os.path.isdir(IN_DIR) else []
if not inputs:
    clear_outputs()
    print(f"[real_positives] nenhum áudio em {IN_DIR} — etapa opcional pulada (saída antiga removida)")
    sys.exit(0)

import soundfile as sf
from scipy.signal import resample_poly


def segments(audio, sr):
    hop = int(SEG_HOP_S * sr)
    frames = len(audio) // hop
    rms = np.sqrt(np.mean(audio[: frames * hop].reshape(frames, hop) ** 2, axis=1))
    db = 20 * np.log10(rms + 1e-9)
    floor, peak = np.percentile(db, 10), np.percentile(db, 99)
    on = db > floor + SEG_THRESHOLD * (peak - floor)
    bridge = int(SEG_BRIDGE_S / SEG_HOP_S)
    kept, dropped = [], []
    i = 0
    while i < frames:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < frames and on[j:j + bridge + 1].any():
            j += 1
        dur = (j - i) * SEG_HOP_S
        if not SEG_MIN_S <= dur <= SEG_MAX_S:
            dropped.append((i * SEG_HOP_S, dur, "duração"))
        elif db[i:j].max() < peak - SEG_MIN_PEAK_DB:
            dropped.append((i * SEG_HOP_S, dur, "fraco"))
        else:
            margin = int(SEG_MARGIN_S * sr)
            kept.append((max(0, i * hop - margin), min(len(audio), j * hop + margin)))
        i = j
    return kept, dropped


clear_outputs()
os.makedirs(os.path.join(CLIPS_DIR, "train"))
os.makedirs(os.path.join(CLIPS_DIR, "holdout"))
holdout_16k = []
n = 0
for path in inputs:
    audio, sr = sf.read(path, always_2d=True)
    audio = audio.mean(axis=1)
    kept, dropped = segments(audio, sr)
    base = os.path.splitext(os.path.basename(path))[0].replace(" ", "_")
    for k, (start, end) in enumerate(kept):
        clip = audio[start:end]
        group = "holdout" if k % HOLDOUT_EVERY == HOLDOUT_EVERY - 1 else "train"
        # FLOAT: o Opus decodificado passa de ±1.0 nos picos, e PCM_16 cortaria.
        sf.write(os.path.join(CLIPS_DIR, group, f"{base}_{k:03d}.wav"), clip, sr, subtype="FLOAT")
        if group == "holdout":
            holdout_16k.append(resample_poly(clip, 16000, sr) if sr != 16000 else clip)
        n += 1
    print(f"[real_positives] {os.path.basename(path)}: {len(kept)} repetição(ões) recortada(s)")
    for t, dur, why in dropped:
        print(f"[real_positives]   descartado em {t:6.2f}s ({dur:.2f}s, {why})")

n_holdout = len(holdout_16k)
n_train = n - n_holdout
if n_train < MIN_TRAIN_CLIPS:
    sys.exit(
        f"[real_positives] só {n_train} repetição(ões) para treino — são necessárias pelo menos "
        f"{MIN_TRAIN_CLIPS} (grave mais, ~{MIN_TRAIN_CLIPS * HOLDOUT_EVERY // (HOLDOUT_EVERY - 1) + 1} no total)."
    )

# Hold-out num arquivo só, com 1 s de silêncio antes (o detector do sidecar
# ignora os primeiros ~450 ms) e 2 s entre repetições (cada uma vira uma
# detecção separada) — pronto para `wake_sidecar.py --wav`.
gap = np.zeros(32000)
sequence = [np.zeros(16000)]
for clip in holdout_16k:
    sequence += [clip, gap]
sequence = np.concatenate(sequence)
# O sidecar lê PCM16: normaliza o pico para -1 dBFS em vez de deixar cortar.
sf.write(HOLDOUT_WAV, sequence * (0.89 / np.abs(sequence).max()), 16000, subtype="PCM_16")
print(f"[real_positives] {n_train} para treino, {n_holdout} no hold-out → {HOLDOUT_WAV}")

from microwakeword.audio.augmentation import Augmentation
from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

clips = Clips(
    input_directory=os.path.join(CLIPS_DIR, "train"),
    file_pattern="*.wav",
    max_clip_duration_s=None,
    remove_silence=False,
    random_split_seed=10,
    split_count=0.1,
)

# Mesmos parâmetros do 03_generate_features.py — os positivos reais têm que
# passar pelo mesmo tipo de ruído/sala que os sintéticos.
augmenter = Augmentation(
    augmentation_duration_s=3.2,
    augmentation_probabilities={
        "SevenBandParametricEQ": 0.1,
        "TanhDistortion": 0.1,
        "PitchShift": 0.1,
        "BandStopFilter": 0.1,
        "AddColorNoise": 0.1,
        "AddBackgroundNoise": 0.75,
        "Gain": 1.0,
        "RIR": 0.5,
    },
    impulse_paths=["mit_rirs"],
    background_paths=["fma_16k", "audioset_16k"],
    background_min_snr_db=-5,
    background_max_snr_db=10,
    min_jitter_s=0.195,
    max_jitter_s=0.205,
)

splits = {"training": "train", "validation": "validation", "testing": "test"}
for split, split_name in splits.items():
    out_dir = os.path.join(TMP_DIR, split)
    os.makedirs(out_dir, exist_ok=True)
    # Mesmo esquema do 03: teste com slide_frames=1.
    slide_frames = 1 if split == "testing" else 10
    spectrograms = SpectrogramGeneration(clips=clips, augmenter=augmenter, slide_frames=slide_frames, step_ms=10)
    print(f"[real_positives/{split}] gerando espectrogramas (split_name={split_name}, repetition={REPEAT[split]}) ...")
    RaggedMmap.from_generator(
        out_dir=os.path.join(out_dir, "wakeword_mmap"),
        sample_generator=spectrograms.spectrogram_generator(split=split_name, repeat=REPEAT[split]),
        batch_size=100,
        verbose=True,
    )

os.rename(TMP_DIR, OUT_DIR)
print(f"[real_positives] concluído — features em {OUT_DIR}")
