#!/usr/bin/env python3
"""Baixa os dados de ruído/reverberação usados para aumentar as amostras
positivas (célula 4 do basic_training_notebook.ipynb do microWakeWord).

Aviso de licença (herdado do notebook): estes dados têm licenças variadas —
modelos treinados com eles servem para uso pessoal não-comercial.
"""
import os
import subprocess
from pathlib import Path

import datasets
import numpy as np
import scipy.io.wavfile
from tqdm import tqdm

# Fixamos datasets==3.6.0 no Dockerfile (ver comentário lá): antes da mudança
# para AudioDecoder/torchcodec na 4.x, então aqui é sempre o dict clássico
# {"array", "path", "sampling_rate"} — igual ao notebook original.

WORK = Path("/work")

# O "bal_train09.tar" do notebook original não existe mais: o repo migrou para
# Parquet (datasets.load_dataset). Streaming + corte no nº de clipes evita
# baixar o dataset balanced inteiro (~22k clipes de 10s) só para ruído de
# fundo — a mesma ordem de grandeza de UM shard do esquema antigo já basta.
AUDIOSET_MAX_CLIPS = 2000


def download_mit_rirs():
    out_dir = WORK / "mit_rirs"
    if any(out_dir.glob("*.wav")):
        print(f"[rir] já existe, pulando: {out_dir}")
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    print("[rir] baixando MIT_environmental_impulse_responses ...")
    ds = datasets.load_dataset(
        "davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True
    )
    for row in tqdm(ds, desc="rir"):
        name = row["audio"]["path"].split("/")[-1]
        scipy.io.wavfile.write(
            out_dir / name, 16000, (row["audio"]["array"] * 32767).astype(np.int16)
        )
    print(f"[rir] ok: {len(list(out_dir.glob('*.wav')))} arquivos")


def download_audioset():
    out_dir = WORK / "audioset_16k"
    if any(out_dir.glob("*.wav")):
        print(f"[audioset] já existe, pulando: {out_dir}")
        return
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[audioset] streaming até {AUDIOSET_MAX_CLIPS} clipes (config 'balanced') ...")
    ds = datasets.load_dataset("agkphysics/AudioSet", "balanced", split="train", streaming=True)
    # cast_column faz a lib resamplear para 16kHz na decodificação — sem
    # precisar de torch/torchaudio manual aqui.
    ds = ds.cast_column("audio", datasets.Audio(sampling_rate=16000))

    count = 0
    for row in tqdm(ds, desc="audioset", total=AUDIOSET_MAX_CLIPS):
        if count >= AUDIOSET_MAX_CLIPS:
            break
        name = f"{row['video_id']}.wav"
        scipy.io.wavfile.write(
            out_dir / name, 16000, (row["audio"]["array"] * 32767).astype(np.int16)
        )
        count += 1

    print(f"[audioset] ok: {len(list(out_dir.glob('*.wav')))} arquivos")


def download_fma():
    out_dir = WORK / "fma_16k"
    raw_dir = WORK / "fma"
    if any(out_dir.glob("*.wav")):
        print(f"[fma] já existe, pulando: {out_dir}")
        return
    raw_dir.mkdir(parents=True, exist_ok=True)

    fname = "fma_xs.zip"
    zip_path = raw_dir / fname
    if not zip_path.exists():
        print("[fma] baixando fma_xs.zip ...")
        link = f"https://huggingface.co/datasets/mchl914/fma_xsmall/resolve/main/{fname}"
        subprocess.run(["wget", "-q", "--show-progress", "-O", str(zip_path), link], check=True)

    print("[fma] extraindo ...")
    subprocess.run(["unzip", "-q", str(zip_path)], cwd=raw_dir, check=True)

    out_dir.mkdir(parents=True, exist_ok=True)
    mp3_files = [str(p) for p in (raw_dir / "fma_small").glob("**/*.mp3")]
    print(f"[fma] convertendo {len(mp3_files)} clipes para 16kHz wav ...")
    ds = datasets.Dataset.from_dict({"audio": mp3_files})
    ds = ds.cast_column("audio", datasets.Audio(sampling_rate=16000))
    for row in tqdm(ds, desc="fma"):
        name = row["audio"]["path"].split("/")[-1].replace(".mp3", ".wav")
        scipy.io.wavfile.write(
            out_dir / name, 16000, (row["audio"]["array"] * 32767).astype(np.int16)
        )
    print(f"[fma] ok: {len(list(out_dir.glob('*.wav')))} arquivos")


if __name__ == "__main__":
    download_mit_rirs()
    download_audioset()
    download_fma()
    print("Concluído.")
