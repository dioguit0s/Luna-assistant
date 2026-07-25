#!/usr/bin/env python3
"""Aumenta as amostras positivas ("hey luna") com ruído/reverb e gera os
espectrogramas de treino/validação/teste (células 5-7 do basic_training_notebook
do microWakeWord). Consome ~poucos GB de RAM/disco; roda várias vezes mais rápido
que o treino em si, mas ainda leva minutos dependendo do nº de amostras.
"""
import os

from microwakeword.audio.augmentation import Augmentation
from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

WORK = "/work"
os.chdir(WORK)

clips = Clips(
    input_directory="generated_samples",
    file_pattern="*.wav",
    max_clip_duration_s=None,
    remove_silence=False,
    random_split_seed=10,
    split_count=0.1,
)

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

output_dir = "generated_augmented_features"
os.makedirs(output_dir, exist_ok=True)

splits = ["training", "validation", "testing"]
for split in splits:
    out_dir = os.path.join(output_dir, split)
    os.makedirs(out_dir, exist_ok=True)

    split_name = "train"
    repetition = 2
    spectrograms = SpectrogramGeneration(
        clips=clips,
        augmenter=augmenter,
        slide_frames=10,
        step_ms=10,
    )
    if split == "validation":
        split_name = "validation"
        repetition = 1
    elif split == "testing":
        split_name = "test"
        repetition = 1
        spectrograms = SpectrogramGeneration(
            clips=clips,
            augmenter=augmenter,
            slide_frames=1,
            step_ms=10,
        )

    print(f"[{split}] gerando espectrogramas (split_name={split_name}, repetition={repetition}) ...")
    RaggedMmap.from_generator(
        out_dir=os.path.join(out_dir, "wakeword_mmap"),
        sample_generator=spectrograms.spectrogram_generator(split=split_name, repeat=repetition),
        batch_size=100,
        verbose=True,
    )

print("Concluído.")
