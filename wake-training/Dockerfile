# Ambiente de treino do microWakeWord com Python 3.10 fixado — o notebook oficial
# quebrou no Colab por causa do Python 3.11, então rodamos local e controlado.
#
# Base travada em bookworm (Debian 12), não a tag rolante "slim": o "slim" já
# migrou para trixie (Debian 13), que traz FFmpeg 7.1 (libavutil.so.59) — o
# torchcodec (usado pelo datasets>=4) só reconhece até a série 5/6
# (libavutil.so.56/57), que é o que o bookworm traz.
FROM python:3.10-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git wget unzip ca-certificates \
      build-essential cmake \
      ffmpeg libsndfile1 espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Torch/torchaudio CPU (build "+cpu" do índice do PyTorch, para não puxar
# CUDA). --extra-index-url, não --index-url: o índice do PyTorch tem uma
# inconsistência de metadado no pacote typing-extensions (hífen vs underscore)
# que quebra a resolução do pip quando ele é a ÚNICA fonte. Com --extra-,
# torch/torchaudio (só existem lá) vêm do índice do PyTorch, e as dependências
# comuns (typing-extensions, sympy, etc.) vêm do PyPI normal.
RUN pip install torch==2.11.0 torchaudio==2.11.0 --extra-index-url https://download.pytorch.org/whl/cpu

# datasets==3.6.0 (não a mais nova): a partir da 4.0, datasets.Audio() passou
# a devolver um AudioDecoder preguiçoso (baseado em torchcodec) em vez do dict
# {"array", "sampling_rate"} de sempre. O microWakeWord (clips.py) usa
# clip["audio"]["array"] direto — quebra com a API nova. Fixar aqui, ANTES do
# microwakeword, evita puxar a 4.x/5.x de volta (o setup.py dele não pina
# versão) e também elimina de vez a necessidade do torchcodec.
RUN pip install datasets==3.6.0

# Deps do microWakeWord. audio-metadata vem de um fork (o pin de attrs quebra).
RUN pip install \
      "git+https://github.com/whatsnowplaying/audio-metadata@d4ebb238e6a401bb1a5aaaac60c9e2b3cb30929f"

# piper-tts: a API do piper-sample-generator mudou (não usa mais
# piper-phonemize-cross); precisa do binário espeak-ng (apt acima) para o
# phonemizer. Instalado com --no-deps porque seu pyproject.toml pinaria
# audiomentations/webrtcvad em versões antigas que conflitam com o
# microWakeWord — piper-tts em si não depende de nenhum dos dois.
RUN pip install --no-deps piper-tts==1.3.0 \
    && pip install onnxruntime numpy protobuf flatbuffers coloredlogs sympy

# microWakeWord + piper-sample-generator clonados na imagem (pinados por commit
# em runtime não; usamos o HEAD no build). O pacote traz TF>=2.18, audiomentations,
# pymicro-features, datasets, etc.
RUN git clone --depth 1 https://github.com/kahrendt/microWakeWord /opt/microWakeWord \
    && pip install -e /opt/microWakeWord

# model_train_eval.py chama tf.summary.scalar durante o loop de treino (log de
# métricas), que exige o pacote tensorboard instalado mesmo sem abrir a UI —
# sem isto o treino quebra na primeira avaliação com TBNotInstalledError.
RUN pip install tensorboard

RUN git clone --depth 1 https://github.com/rhasspy/piper-sample-generator /opt/piper-sample-generator

# Voz TTS (libritts) usada para gerar as amostras da wake word.
RUN wget -q -O /opt/piper-sample-generator/models/en_US-libritts_r-medium.pt \
      'https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt'

ENV PYTHONPATH=/opt/piper-sample-generator
WORKDIR /work
