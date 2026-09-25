#!/usr/bin/env python3
"""Gera features de negativos CUSTOMIZADOS (pt-BR) a partir de WAVs fornecidos
pelo humano — passo que os negativos pré-processados do microWakeWord
(`04_download_negatives.sh`, todos em inglês) não cobrem.

Motivação: o modelo treinado só com `speech`/`dinner_party`/`no_speech` (en)
nunca viu frases do dia a dia em português como negativo, então "é a Luna",
"lua", "uma", trechos de TV ou conversa em pt-BR têm mais chance de cruzar o
cutoff por acidente — ver a seção "Se o modelo dispara demais" no README.

Entrada esperada, em `/work/custom_negatives_wav/` — qualquer WAV (ou `.WAV`),
mono ou estéreo, qualquer sample rate (o `Clips` do microWakeWord reamostra e
converte para mono), em dois grupos:

- `fundo/` (ou soltos na raiz): TV, rádio, conversa de fundo em pt-BR. Costuma
  ser muito áudio (minutos) e pouco específico.
- `confundiveis/`: as palavras/frases parecidas com "hey luna" ("lua", "uma",
  "luna" sem o "hey", "e aí, luna"). Costuma ser pouco áudio (segundos), mas é
  o que mais importa.

Os grupos viram diretórios de features separados, com `sampling_weight`
próprio em `05_write_training_config.py` — no mesmo diretório, 20 min de TV
virariam ~99% das amostras pt-BR e as frases confundíveis sumiriam no sorteio.
Grupo sem WAVs é pulado e sua saída anterior (se houver) é apagada — a etapa
toda é opcional, ao contrário das outras (que rodam sempre em `run.sh all`).

Antes de gerar as features, cada WAV é recortado em janelas (em
/work/custom_negatives_chunks, refeito a cada execução). Sem isso o `Clips`
trata cada arquivo como UMA amostra: um WAV de 15 min de TV pesaria o mesmo
que um "lua" de 1 s, e o split train/validation/test por arquivo podia mandar
a gravação inteira para validação. Com poucas amostras (≤5) o split nem
fecha — o `train_test_split` aninhado do `Clips` precisa de ≥6. As frases
confundíveis usam janelas do tamanho do clipe de treino (1,5 s,
`clip_duration_ms` no 05) com sobreposição, para 15 s de gravação já renderem
amostras suficientes e cada palavra aparecer inteira em alguma janela.

Ao contrário de `03_generate_features.py` (que aumenta POSITIVOS com
ruído/reverb via `Augmentation`, célula 5-7 do notebook oficial), aqui os
clipes já são o ambiente real (TV, sala, etc.) — não augmentamos de novo.
`truth=False` é decidido depois, em `05_write_training_config.py`.

A etapa sempre regenera do zero (não pula se a saída existir): gera em um
diretório temporário e só troca pelo definitivo no fim, para que uma falha no
meio nunca deixe um `*_mmap` vazio que o `05` incluiria e quebraria o treino.
"""
import os
import shutil
import sys

WORK = "/work"
IN_DIR = os.path.join(WORK, "custom_negatives_wav")
CHUNK_ROOT = os.path.join(WORK, "custom_negatives_chunks")
OUT_ROOT = os.path.join(WORK, "negative_datasets")
# Saída da versão anterior deste script (um grupo só) — apagada para não
# continuar entrando no treino junto com os grupos novos.
LEGACY_OUT = os.path.join(OUT_ROOT, "custom_ptbr")

# grupo -> (janela em s, passo em s). Os nomes de saída (custom_ptbr_<grupo>)
# precisam bater com CUSTOM_PTBR_GROUPS em 05_write_training_config.py.
GROUPS = {
    "fundo": (3.0, 3.0),
    "confundiveis": (1.5, 0.5),
}
# Janelas menores que isto são descartadas: abaixo de ~120 ms (10 frames de
# feature) o SpectrogramGeneration quebra com ValueError.
MIN_CHUNK_S = 0.5
# O Clips separa 10% para validação e 10% para teste (ceil em cada); abaixo
# disso algum split fica vazio e o train_test_split levanta ValueError.
MIN_CHUNKS = 10

os.chdir(WORK)


def list_wavs(d):
    if not os.path.isdir(d):
        return []
    return sorted(
        os.path.join(d, f) for f in os.listdir(d)
        if f.lower().endswith(".wav") and os.path.isfile(os.path.join(d, f))
    )


inputs = {g: list_wavs(os.path.join(IN_DIR, g)) for g in GROUPS}
inputs["fundo"] += list_wavs(IN_DIR)  # WAVs soltos na raiz contam como fundo

if os.path.isdir(LEGACY_OUT):
    shutil.rmtree(LEGACY_OUT)
    print(f"[custom_ptbr] removida saída antiga de grupo único em {LEGACY_OUT}")

for group, wavs in inputs.items():
    out_dir = os.path.join(OUT_ROOT, f"custom_ptbr_{group}")
    if not wavs and os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
        print(f"[custom_ptbr_{group}] sem WAVs — removida a saída antiga em {out_dir}")

if not any(inputs.values()):
    print(
        f"[custom_ptbr] nenhum .wav em {IN_DIR} (nem em {'/, '.join(GROUPS)}/) — etapa opcional pulada. "
        "Ver 'Se o modelo dispara demais' no README para gravar os negativos."
    )
    sys.exit(0)

import soundfile as sf


def cut(group, wavs):
    window_s, hop_s = GROUPS[group]
    chunk_dir = os.path.join(CHUNK_ROOT, group)
    shutil.rmtree(chunk_dir, ignore_errors=True)
    os.makedirs(chunk_dir)
    n = 0
    for path in wavs:
        audio, sr = sf.read(path, always_2d=True)
        window, hop = int(window_s * sr), int(hop_s * sr)
        base = os.path.splitext(os.path.basename(path))[0]
        for i, start in enumerate(range(0, len(audio), hop)):
            piece = audio[start:start + window]
            if len(piece) < MIN_CHUNK_S * sr:
                break
            sf.write(os.path.join(chunk_dir, f"{base}_{i:05d}.wav"), piece, sr)
            n += 1
            if start + window >= len(audio):
                break
    if n < MIN_CHUNKS:
        sys.exit(
            f"[custom_ptbr_{group}] só {n} janela(s) de ≥{MIN_CHUNK_S:g}s — são necessárias pelo menos "
            f"{MIN_CHUNKS} (~{(MIN_CHUNKS - 1) * hop_s + window_s:g}s de áudio no grupo). Grave mais clipes."
        )
    print(f"[custom_ptbr_{group}] {len(wavs)} WAV(s) → {n} janela(s) de {window_s:g}s (passo {hop_s:g}s)")
    return chunk_dir


# Recorta tudo antes de importar o microWakeWord (lento): se algum grupo tiver
# áudio de menos, falha em segundos, não depois de gerar os outros.
chunk_dirs = {g: cut(g, wavs) for g, wavs in inputs.items() if wavs}

from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

for group, chunk_dir in chunk_dirs.items():
    out_dir = os.path.join(OUT_ROOT, f"custom_ptbr_{group}")
    tmp_dir = out_dir + ".tmp"
    clips = Clips(
        input_directory=chunk_dir,
        file_pattern="*.wav",
        max_clip_duration_s=None,
        remove_silence=False,
        random_split_seed=10,
        split_count=0.1,
    )

    # Sem Augmentation: os clipes já vêm do ambiente real (mic, TV, conversa)
    # que se quer rejeitar — augmentar de novo só dilui o sinal específico que
    # importa aqui, que é "essa frase pt-BR não deveria disparar".
    shutil.rmtree(tmp_dir, ignore_errors=True)
    splits = {"training": "train", "validation": "validation", "testing": "test"}
    for split, split_name in splits.items():
        split_dir = os.path.join(tmp_dir, split)
        os.makedirs(split_dir, exist_ok=True)
        repetition = 2 if split == "training" else 1
        # Mesmo esquema do 03: teste com slide_frames=1, para não inflar as
        # métricas com 10 cópias quase idênticas de cada janela.
        slide_frames = 1 if split == "testing" else 10
        spectrograms = SpectrogramGeneration(clips=clips, augmenter=None, slide_frames=slide_frames, step_ms=10)
        print(f"[custom_ptbr_{group}/{split}] gerando espectrogramas (split_name={split_name}, repetition={repetition}) ...")
        RaggedMmap.from_generator(
            out_dir=os.path.join(split_dir, "wakeword_mmap"),
            sample_generator=spectrograms.spectrogram_generator(split=split_name, repeat=repetition),
            batch_size=100,
            verbose=True,
        )

    shutil.rmtree(out_dir, ignore_errors=True)
    os.rename(tmp_dir, out_dir)
    print(f"[custom_ptbr_{group}] concluído — features em {out_dir}")
