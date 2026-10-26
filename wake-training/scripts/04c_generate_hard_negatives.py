#!/usr/bin/env python3
"""Gera NEGATIVOS DIFÍCEIS sintéticos: frases curtas que soam parecido com
"hey luna" ou que têm o mesmo formato dela (silêncio → 1-2 palavras), em vozes
Piper pt-BR e na voz inglesa multi-falante do `01_generate_samples.sh`.

Motivação (medido em 2026-10-26 com `luna-desktop/wakeword-sidecar/evaluate.py`):
o `hey_luna_ptbr` dispara ~9 vezes por hora em fala pt-BR que nunca viu
(FLEURS pt_br, 79 min, cutoff 0.99), com média 0.99+ — não é limiar, é o
modelo convicto. A maioria dos disparos cai 1-3 s depois do começo de uma
frase ("A culinária maiorquina...", "NHK também disse...", "Ele usa..."): o
padrão "silêncio, depois começo de fala" é exatamente o formato de TODO
positivo do treino (o clipe curto colado no fim da janela de augmentation), e
quase nenhum negativo tem esse formato — os negativos de fala são recortes
aleatórios de fala contínua. O modelo pode estar aprendendo "começo de fala"
em vez de "hey luna".

Estes negativos têm o mesmo formato dos positivos: clipes curtos, a MESMA
`Augmentation` do `03_generate_features.py` (ruído de fundo, RIR, jitter) e,
em `05_write_training_config.py`, a mesma `truncate_start` — a frase termina
no fim da janela, como o "hey luna". A única coisa que os separa dos positivos
passa a ser o conteúdo.

As frases (`PTBR_PHRASES`/`EN_PHRASES`) misturam dois tipos:
- confundíveis: "lua", "uma", "Luana", "ei, Lúcia", "a Luna"...;
- formato: frases do dia a dia ditas perto do satélite ("liga a TV", "bom
  dia") — o começo de fala sem a wake word.
NENHUMA pode ser uma variação aceitável da wake word ("ei Luna", "rei Luna",
"e aí Luna") — isso ensinaria o modelo a rejeitar o próprio "hey luna". Elas
estão nos positivos de `01b_generate_ptbr_samples.py`.

Hold-out: 1 de cada HOLDOUT_EVERY frases pt-BR nunca entra no treino — é
sintetizada (uma vez por voz) em /work/eval_negatives/confundiveis_sinteticos/,
que o `./run.sh evaluate` usa como régua. Medir nas frases treinadas diria só
que o modelo decorou aquelas frases.

Idempotente na síntese (pula se já houver a quantidade esperada de clipes;
outra quantidade = apaga e regera). As features sempre regeneram, num .tmp
renomeado só no fim (mesmo motivo do 04b: um `*_mmap` vazio quebraria o
treino). Saída: /work/negative_datasets/hard_negatives/.
"""
import glob
import itertools
import os
import random
import shutil
import subprocess
import sys
import urllib.request
import wave

WORK = "/work"
SAMPLES_DIR = os.path.join(WORK, "hard_negative_samples")
EVAL_DIR = os.path.join(WORK, "eval_negatives", "confundiveis_sinteticos")
OUT_DIR = os.path.join(WORK, "negative_datasets", "hard_negatives")
TMP_DIR = OUT_DIR + ".tmp"
VOICES_DIR = os.path.join(WORK, "piper_voices")

# Mesmas vozes e mesma origem do 01b (já baixadas por ele, se rodou antes).
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR"
VOICES = ["faber-medium", "cadu-medium", "jeff-medium", "edresson-low"]
EN_GENERATOR = "/opt/piper-sample-generator/models/en_US-libritts_r-medium.pt"

PTBR_PHRASES = [
    # confundíveis — sons de "ei", "lu", "na", "uma"
    "Lua", "A lua", "Olha a lua", "Lua cheia", "Ei, lua", "Uma", "É uma", "Tem uma",
    "Nenhuma", "Alguma", "Uma luz", "Luana", "Ei, Luana", "Luciana", "Juliana",
    "Bruna", "Ei, Bruna", "Helena", "Ei, Helena", "Lena", "Ei, Lena", "Lúcia",
    "Ei, Lúcia", "Luíza", "Lula", "Ei, Lula", "O Lula", "Lunar", "Coluna",
    "Lacuna", "Fortuna", "Duna", "Lona", "Luva", "Lume", "Menina", "Vacina",
    "Meia-lua", "Alumínio", "Rei", "O rei", "Hein?", "Ei", "Ei, você", "Ei, psiu",
    "Oi", "Olá", "Ei, uma pergunta", "Ela é uma", "Então", "Leva uma",
    # "Luna" sem o "ei" na frente. Poucas e no meio de frase: é o que mais
    # perto chega da wake word, e peso demais aqui deixa o modelo surdo.
    "A Luna", "Cadê a Luna?", "Falei com a Luna", "A Luna é bonita",
    # formato — começo de fala comum, sem nada parecido com a wake word
    "Liga a TV", "Desliga a luz", "Acende a luz", "Que horas são?", "Bom dia",
    "Boa noite", "Tudo bem?", "Tô com fome", "Vamos embora", "Cadê o controle?",
    "Fecha a porta", "Obrigado", "Pode ser", "Agora não", "Me ajuda aqui",
    "Que calor", "Já volto", "Onde você está?", "Olha só", "Deixa comigo",
]
EN_PHRASES = [
    "hey", "hey you", "hey Lou", "hey Laura", "hey Lena", "hey look", "hey listen",
    "hello", "honey", "Luna", "lunar", "hey Luke", "hey Lucy", "hey Lunar",
    "hey Google", "Alexa", "okay Nabu", "hey Siri", "good morning", "turn on the lights",
]

HOLDOUT_EVERY = 5
TRAIN_PTBR = [t for i, t in enumerate(PTBR_PHRASES) if i % HOLDOUT_EVERY != HOLDOUT_EVERY - 1]
HOLDOUT_PTBR = [t for i, t in enumerate(PTBR_PHRASES) if i % HOLDOUT_EVERY == HOLDOUT_EVERY - 1]
PTBR_PER_PHRASE_PER_VOICE = int(os.environ.get("HARD_NEG_PTBR_PER_VOICE", "6"))
EN_PER_PHRASE = int(os.environ.get("HARD_NEG_EN_PER_PHRASE", "40"))
LENGTH_SCALES = [0.8, 0.95, 1.1, 1.25]
NOISE_SCALES = [0.5, 0.667, 0.9]
NOISE_W_SCALES = [0.6, 0.8, 1.0]
MARGIN_S = 0.05
# Mesmas repetições de augmentation do 03 para os sintéticos.
REPEAT = {"training": 2, "validation": 1, "testing": 1}

os.chdir(WORK)


def trim(pcm: bytes, sr: int) -> bytes:
    """Corta o silêncio das pontas — mesma regra do 01b, para que estes
    clipes fiquem tão colados ao fim da janela quanto os positivos."""
    import numpy as np

    a = np.frombuffer(pcm, dtype=np.int16)
    hop = int(0.01 * sr)
    peaks = np.array([np.abs(a[i:i + hop]).max() for i in range(0, len(a) - hop, hop)])
    if peaks.size == 0 or peaks.max() == 0:
        return pcm
    on = np.where(peaks > 0.05 * peaks.max())[0]
    margin = int(MARGIN_S * sr)
    start = max(0, on[0] * hop - margin)
    end = min(len(a), (on[-1] + 1) * hop + margin)
    return a[start:end].tobytes()


def write_wav(path: str, pcm: bytes, sr: int) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)


def synth_ptbr(out_dir: str, eval_dir: str) -> int:
    from piper import PiperVoice, SynthesisConfig

    os.makedirs(VOICES_DIR, exist_ok=True)
    rng = random.Random(20)
    n = 0
    for name in VOICES:
        speaker, quality = name.rsplit("-", 1)
        base = f"pt_BR-{name}"
        for ext in (".onnx", ".onnx.json"):
            dst = os.path.join(VOICES_DIR, base + ext)
            if not os.path.exists(dst):
                url = f"{HF}/{speaker}/{quality}/{base}{ext}"
                print(f"[hard_negatives] baixando {url}")
                urllib.request.urlretrieve(url, dst + ".part")
                os.rename(dst + ".part", dst)
        voice = PiperVoice.load(os.path.join(VOICES_DIR, base + ".onnx"))
        combos = list(itertools.product(LENGTH_SCALES, NOISE_SCALES, NOISE_W_SCALES))
        for p, text in enumerate(TRAIN_PTBR):
            for i, (ls, ns, nw) in enumerate(rng.sample(combos, PTBR_PER_PHRASE_PER_VOICE)):
                cfg = SynthesisConfig(length_scale=ls, noise_scale=ns, noise_w_scale=nw)
                chunks = list(voice.synthesize(text, syn_config=cfg))
                sr = chunks[0].sample_rate
                pcm = trim(b"".join(c.audio_int16_bytes for c in chunks), sr)
                write_wav(os.path.join(out_dir, f"ptbr_{name}_{p:03d}_{i:02d}.wav"), pcm, sr)
                n += 1
        # Hold-out: síntese padrão, sem trim nem augmentation — é a régua, não treino.
        for p, text in enumerate(HOLDOUT_PTBR):
            chunks = list(voice.synthesize(text))
            pcm = b"".join(c.audio_int16_bytes for c in chunks)
            write_wav(os.path.join(eval_dir, f"{name}_{p:03d}.wav"), pcm, chunks[0].sample_rate)
        print(f"[hard_negatives] {name}: {len(TRAIN_PTBR) * PTBR_PER_PHRASE_PER_VOICE} clipes pt-BR "
              f"(+{len(HOLDOUT_PTBR)} no hold-out)")
    return n


def synth_en(out_dir: str) -> int:
    # O gerador libritts sorteia falantes a cada amostra — é o que dá variedade
    # de voz aqui. Uma frase por chamada: com várias, ele numera os arquivos
    # 0.wav, 1.wav... e uma frase sobrescreveria a outra.
    n = 0
    for p, text in enumerate(EN_PHRASES):
        tmp = os.path.join(out_dir, f"_tmp_{p:03d}")
        shutil.rmtree(tmp, ignore_errors=True)
        subprocess.run(
            [
                sys.executable, "-m", "piper_sample_generator", text,
                "--model", EN_GENERATOR,
                "--max-samples", str(EN_PER_PHRASE),
                "--batch-size", "20",
                "--output-dir", tmp,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        for i, f in enumerate(sorted(glob.glob(os.path.join(tmp, "*.wav")))):
            os.rename(f, os.path.join(out_dir, f"en_{p:03d}_{i:03d}.wav"))
            n += 1
        shutil.rmtree(tmp)
    print(f"[hard_negatives] {n} clipes em inglês ({len(EN_PHRASES)} frases)")
    return n


expected = len(VOICES) * len(TRAIN_PTBR) * PTBR_PER_PHRASE_PER_VOICE + len(EN_PHRASES) * EN_PER_PHRASE
existing = glob.glob(os.path.join(SAMPLES_DIR, "*.wav"))
existing_eval = glob.glob(os.path.join(EVAL_DIR, "*.wav"))
if len(existing) == expected and len(existing_eval) == len(VOICES) * len(HOLDOUT_PTBR):
    print(f"[hard_negatives] {len(existing)} clipes já existem em {SAMPLES_DIR} — pulando a síntese")
else:
    if existing:
        print(f"[hard_negatives] {len(existing)} clipes (esperados {expected}) — apagando e regerando")
    for d in (SAMPLES_DIR, EVAL_DIR):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    total = synth_ptbr(SAMPLES_DIR, EVAL_DIR) + synth_en(SAMPLES_DIR)
    print(f"[hard_negatives] {total} clipes sintetizados em {SAMPLES_DIR}")

from microwakeword.audio.augmentation import Augmentation
from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

clips = Clips(
    input_directory=SAMPLES_DIR,
    file_pattern="*.wav",
    max_clip_duration_s=None,
    remove_silence=False,
    random_split_seed=10,
    split_count=0.1,
)

# Idêntica à do 03_generate_features.py: se a augmentation dos negativos
# difíceis fosse outra, o modelo poderia separá-los dos positivos pelo ruído
# ou pela sala, não pela frase.
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

shutil.rmtree(TMP_DIR, ignore_errors=True)
splits = {"training": "train", "validation": "validation", "testing": "test"}
for split, split_name in splits.items():
    out_dir = os.path.join(TMP_DIR, split)
    os.makedirs(out_dir, exist_ok=True)
    slide_frames = 1 if split == "testing" else 10
    spectrograms = SpectrogramGeneration(clips=clips, augmenter=augmenter, slide_frames=slide_frames, step_ms=10)
    print(f"[hard_negatives/{split}] gerando espectrogramas (split_name={split_name}, repetition={REPEAT[split]}) ...")
    RaggedMmap.from_generator(
        out_dir=os.path.join(out_dir, "wakeword_mmap"),
        sample_generator=spectrograms.spectrogram_generator(split=split_name, repeat=REPEAT[split]),
        batch_size=100,
        verbose=True,
    )

shutil.rmtree(OUT_DIR, ignore_errors=True)
os.rename(TMP_DIR, OUT_DIR)
print(f"[hard_negatives] concluído — features em {OUT_DIR}")
