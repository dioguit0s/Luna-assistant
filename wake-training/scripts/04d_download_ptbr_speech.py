#!/usr/bin/env python3
"""Baixa fala pt-BR pública (Google FLEURS, `pt_br`, CC-BY 4.0) em dois
destinos que NUNCA se misturam:

- split `train` (~1,8 GB, milhares de frases lidas por dezenas de falantes) →
  /work/custom_negatives_wav/fala/ — vira o grupo `fala` do
  `04b_generate_custom_negatives.py`, negativo de treino;
- splits `dev` e `test` (falantes que não estão no `train`) →
  /work/eval_negatives/fleurs_ptbr/ — régua de falsos disparos por hora do
  `./run.sh evaluate`, nunca treinada.

Motivação: os únicos negativos pt-BR do treino eram 22 min de UM vídeo de TV,
e a única medição de falso-positivo em pt-BR era nesses mesmos 22 min (2
disparos — otimista, o modelo tinha visto o áudio). Em 79 min do `dev` do
FLEURS o `hey_luna_ptbr` deu ~9 disparos/hora em 0.99 (medido em 2026-10-26).
Cada arquivo do FLEURS é uma frase com silêncio nas pontas, então a janela
inicial de cada um (o recorte de 3 s do 04b começa no início do arquivo) traz
o "silêncio → começo de fala" que é onde a maioria dos disparos acontece.

Idempotente: pula cada destino já baixado por inteiro. Para baixar de novo,
apague o diretório. Rodar `custom_negatives` depois (é ele que gera as
features do grupo `fala`).
"""
import os
import shutil
import tarfile
import urllib.request

WORK = "/work"
BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br/audio"
TRAIN_DIR = os.path.join(WORK, "custom_negatives_wav", "fala")
EVAL_DIR = os.path.join(WORK, "eval_negatives", "fleurs_ptbr")
DOWNLOADS = os.path.join(WORK, "downloads")
TARGETS = {
    "train": TRAIN_DIR,
    "dev": EVAL_DIR,
    "test": EVAL_DIR,
}


# Marcador gravado só depois que TODOS os splits de um destino foram
# extraídos — um download interrompido entre `dev` e `test` não pode fazer a
# próxima execução pular o destino.
DONE_MARK = ".completo"


def fetch(split, dest):
    os.makedirs(DOWNLOADS, exist_ok=True)
    tar_path = os.path.join(DOWNLOADS, f"fleurs_pt_br_{split}.tar.gz")
    if not os.path.exists(tar_path):
        url = f"{BASE}/{split}.tar.gz"
        print(f"[ptbr_speech] baixando {url}")
        urllib.request.urlretrieve(url, tar_path + ".part")
        os.rename(tar_path + ".part", tar_path)
    # Extrai num .tmp e só então move: um tar interrompido no meio não pode
    # deixar o destino "com arquivos" e pular a próxima execução.
    tmp = dest + f".{split}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    n = 0
    with tarfile.open(tar_path) as tar:
        for member in tar:
            if not member.isfile() or not member.name.lower().endswith(".wav"):
                continue
            # Achata o caminho (o tar traz `<split>/<id>.wav`): só o nome do
            # arquivo é usado, então nada é escrito fora de `tmp`.
            name = f"{split}_{os.path.basename(member.name)}"
            with tar.extractfile(member) as src, open(os.path.join(tmp, name), "wb") as dst:
                shutil.copyfileobj(src, dst)
            n += 1
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(tmp):
        os.rename(os.path.join(tmp, f), os.path.join(dest, f))
    os.rmdir(tmp)
    os.remove(tar_path)  # só o áudio extraído importa daqui em diante
    print(f"[ptbr_speech] {split}: {n} frases → {dest}")


for dest in dict.fromkeys(TARGETS.values()):
    if os.path.exists(os.path.join(dest, DONE_MARK)):
        print(f"[ptbr_speech] {dest} já baixado — pulando (apague para baixar de novo)")
        continue
    shutil.rmtree(dest, ignore_errors=True)
    for split, d in TARGETS.items():
        if d == dest:
            fetch(split, dest)
    open(os.path.join(dest, DONE_MARK), "w").close()

print("[ptbr_speech] pronto — rode `./run.sh custom_negatives` para gerar as features do grupo `fala`")
