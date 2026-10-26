#!/usr/bin/env python
"""Régua de falso-positivo e recall do wake word — compara modelos e cutoffs.

`wake_sidecar.py --wav` responde "quantas detecções neste arquivo, neste
cutoff". Isso não basta para decidir se um modelo está pronto: o número que
importa para quem mora com o satélite é **disparos falsos por hora** em fala
comum, e ele só aparece com horas de áudio e uma varredura de cutoff. Este
script faz as duas coisas com o mesmo caminho de inferência do sidecar
(`MicroFeatures` + `LoadedModel` + `WakeDetector`, ou seja, paridade com
`WakeWord.cpp`):

    python evaluate.py --model ../../luna-firmware/models/hey_luna_ptbr.tflite \\
        --positive fixtures/hey-luna.wav:11 \\
        --negative ~/fala-ptbr/ --negative fixtures/okay-nabu.wav

- Cada áudio passa pelo modelo UMA vez; as probabilidades cruas são
  reaproveitadas para todos os cutoffs (o detector é puro e determinístico).
- Áudio: `.wav` (PCM16 ou float), `.ogg`/`.opus` do WhatsApp, `.flac`, `.mp3`.
- `--negative` aceita arquivo ou diretório (recursivo). Os arquivos de um
  mesmo `--negative` são emendados num fluxo só, sem `rearm()` entre eles
  (o settle de ~450 ms não esconde nada), separados por `NEG_GAP_S` de
  silêncio para o refratário de um disparo não engolir o arquivo seguinte.
  As horas da taxa contam só o áudio, não esse silêncio. Por conjunto sai o
  número de disparos, a taxa por hora e quantos arquivos dispararam — este
  último é o número que importa num diretório de frases curtas.
- `--positive DIR`: cada arquivo é UMA repetição da wake word (ex.
  `wake-training/work/real_positives_clips/holdout/`). Acerto = detecção
  dentro do clipe ou até `HIT_TAIL_S` depois; detecção fora disso conta como
  disparo fora de hora.
- `--positive arquivo:N`: um arquivo com N repetições (ex.
  `fixtures/hey-luna.wav:11`). Conta detecções: acertos = min(detecções, N).
  Segmentar por energia seria mais fino, mas erra no áudio pós-AGC do desktop
  (testado: achava de 5 a 12 repetições no mesmo arquivo de 11).
- A tabela final lista, por modelo e cutoff: recall nos positivos, disparos
  falsos e disparos/hora nos negativos. `--top` lista onde os piores
  falsos aconteceram (arquivo + segundo), para ouvir o trecho e, se fizer
  sentido, levá-lo para `wake-training/work/custom_negatives_wav/confundiveis/`.
- `--json` grava tudo num arquivo para comparar rodadas depois.

Importante: só vale como régua o áudio que o modelo **não** viu no treino. Os
22 min de TV em `custom_negatives_wav/fundo/` entram no treino — medir neles é
otimista. Ver `wake-training/README.md`, "Critério de aceite".
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from detector import FEATURE_SIZE, FEATURE_STEP_MS, WakeDetector
from frontend import MicroFeatures
from model import ModelError, load_model
from wavio import SAMPLE_RATE, _resample_linear, read_wav_pcm16

if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_CUTOFFS = (0.8, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995)
AUDIO_EXTS = (".wav", ".ogg", ".opus", ".mp3", ".flac")

# A detecção só conclui depois da palavra acabar (média de 5 inferências de
# 30 ms, mais o atraso do modelo streaming): até isto depois do fim do clipe
# ainda é a mesma repetição.
HIT_TAIL_S = 1.0
# Silêncio em volta de cada clipe de um --positive DIR: antes, para o settle
# do detector e o fim do clipe anterior não engolirem o começo; depois, para
# caber o HIT_TAIL_S e o refratário (~1,5 s com stride 3) não atravessar para
# o próximo clipe.
POS_PAD_BEFORE_S = 1.0
POS_PAD_AFTER_S = 2.0
# Silêncio entre arquivos emendados de um --negative. Maior que o refratário
# (REARM_WINDOWS x stride 3 x 10 ms = 1,5 s) somado ao HIT_TAIL_S, senão num
# diretório de frases de ~1 s um disparo apaga o da frase seguinte.
NEG_GAP_S = 2.0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


@dataclass
class Stream:
    """Um áudio contínuo e de onde veio cada trecho dele."""

    label: str
    pcm: bytes
    # (início, fim) em s no fluxo e o arquivo de origem — para traduzir o
    # instante de um disparo de volta para "arquivo X, segundo Y" e, nos
    # positivos por clipe, saber a qual repetição ele pertence.
    parts: list[tuple[float, float, str]] = field(default_factory=list)
    # Positivo `arquivo:N`: número de repetições; None = um clipe por arquivo.
    expected: int | None = None

    @property
    def seconds(self) -> float:
        return len(self.pcm) / (2 * SAMPLE_RATE)

    @property
    def audio_seconds(self) -> float:
        """Só o áudio dos arquivos, sem o silêncio inserido entre eles."""
        return sum(end - start for start, end, _name in self.parts)

    def part_index(self, t: float) -> int | None:
        """Índice do arquivo a que um disparo em `t` pertence (ver `locate`)."""
        prev = None
        for k, (start, _end, _name) in enumerate(self.parts):
            if start > t:
                break
            prev = k
        if prev is not None and prev > 0 and t - self.parts[prev][0] < HIT_TAIL_S:
            if t <= self.parts[prev - 1][1] + HIT_TAIL_S:
                return prev - 1
        return prev

    def locate(self, t: float) -> str:
        """"arquivo @ segundo" de um disparo. A detecção conclui até
        `HIT_TAIL_S` depois do áudio que a causou, então um disparo logo no
        começo de um arquivo, colado no fim do anterior, é atribuído ao
        anterior (senão o --top apontaria o trecho errado para ouvir)."""
        k = self.part_index(t)
        if k is None:
            return f"{self.label} @ {t:.1f}s"
        start, end, name = self.parts[k]
        return f"{name} @ {t - start:.1f}s" + (" (fim)" if t > end else "")


def list_audio(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(p for p in path.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXTS)
    return [path]


def read_audio(path: Path) -> bytes:
    """PCM16LE mono 16 kHz. WAV PCM16 vai pelo mesmo `read_wav_pcm16` do
    sidecar; o resto (WAV float de corpus como o FLEURS, `.ogg` do WhatsApp,
    `.flac`, `.mp3`) passa pelo soundfile e pelo mesmo resample linear."""
    if path.suffix.lower() == ".wav":
        try:
            return read_wav_pcm16(path)
        except Exception:
            pass  # WAV não-PCM16 (float, 24 bits): cai no soundfile abaixo
    import soundfile as sf

    audio, rate = sf.read(str(path), always_2d=True, dtype="float64")
    samples = np.clip(np.round(audio.mean(axis=1) * 32767), -32768, 32767).astype(np.int16)
    if rate != SAMPLE_RATE:
        samples = _resample_linear(samples, rate, SAMPLE_RATE)
    return samples.astype("<i2").tobytes()


# Nível do "silêncio" inserido entre arquivos (RMS em LSB de PCM16, ~-60 dBFS):
# piso de ruído de sala, não zero digital. Com zeros o PCAN do frontend sobe o
# ganho no vazio e toda retomada de fala vira um ataque exagerado — medido:
# o FLEURS com 2 s de zeros entre frases dava o dobro de disparos de 0,2 s de
# zeros. Nenhum microfone real entrega zero digital.
GAP_NOISE_RMS = 30.0


def silence(seconds: float) -> bytes:
    rng = np.random.default_rng(0)
    noise = rng.normal(0.0, GAP_NOISE_RMS, int(seconds * SAMPLE_RATE))
    return np.clip(np.round(noise), -32768, 32767).astype("<i2").tobytes()


def load_stream(spec: str, *, positive: bool) -> Stream:
    expected = None
    raw = spec
    if positive and ":" in spec:
        head, tail = spec.rsplit(":", 1)
        if tail.isdigit():
            raw, expected = head, int(tail)
    path = Path(raw).expanduser()
    files = list_audio(path)
    if not files:
        raise SystemExit(f"nenhum áudio em {path}")
    if positive and expected is None and not path.is_dir():
        raise SystemExit(f"--positive {spec}: passe um diretório (um clipe por arquivo) ou arquivo:N")
    per_clip = positive and expected is None
    before, after = (POS_PAD_BEFORE_S, POS_PAD_AFTER_S) if per_clip else (0.0, NEG_GAP_S)

    pcm = bytearray()
    parts = []
    for f in files:
        pcm += silence(before)
        start = len(pcm) / (2 * SAMPLE_RATE)
        pcm += read_audio(f)
        end = len(pcm) / (2 * SAMPLE_RATE)
        pcm += silence(after)
        parts.append((start, end, str(f.relative_to(path)) if path.is_dir() else f.name))
    return Stream(label=path.name, pcm=bytes(pcm), parts=parts, expected=expected)


def raw_outputs(model_path: Path, pcm: bytes) -> tuple[list[int], int]:
    """Roda o modelo uma vez no fluxo inteiro; devolve as saídas uint8 cruas
    (uma por inferência) e o stride. Modelo e frontend novos por fluxo, com o
    mesmo `rearm()` inicial do boot do firmware."""
    loaded = load_model(model_path)
    features = MicroFeatures(loaded.quantization)
    outputs: list[int] = []

    def infer(tensor: np.ndarray) -> int:
        raw = loaded.infer(tensor)
        outputs.append(raw)
        return raw

    # cutoff > 1 nunca dispara: aqui só interessa colher as saídas.
    detector = WakeDetector(stride=loaded.stride, infer=infer, reset=loaded.reset, cutoff=2.0)
    detector.rearm()
    step = 640  # mesmo quantum de 20 ms do sidecar
    for offset in range(0, len(pcm), step):
        for feature_slice in features.push_pcm(pcm[offset : offset + step]):
            detector.push_feature(feature_slice)
    return outputs, loaded.stride


def replay(outputs: list[int], stride: int, cutoff: float) -> list[tuple[float, float]]:
    """Reaplica o detector sobre saídas já calculadas — mesma média móvel,
    refratário e settle do `WakeDetector`. Devolve (instante em s, média) de
    cada detecção."""
    it = iter(outputs)
    detector = WakeDetector(stride=stride, infer=lambda _t: next(it), reset=lambda: None, cutoff=cutoff)
    detector.rearm()
    dummy = np.zeros(FEATURE_SIZE, dtype=np.int8)
    hits = []
    for _ in range(len(outputs) * stride):
        det = detector.push_feature(dummy)
        if det is not None:
            hits.append((det.inference * stride * FEATURE_STEP_MS / 1000.0, det.mean_prob))
    return hits


def score_positive(stream: Stream, hits: list[tuple[float, float]]) -> tuple[int, int, int]:
    """(repetições acertadas, total de repetições, detecções fora de hora)."""
    if stream.expected is not None:
        return min(len(hits), stream.expected), stream.expected, max(0, len(hits) - stream.expected)
    found = [False] * len(stream.parts)
    stray = 0
    for t, _mean in hits:
        for k, (start, end, _name) in enumerate(stream.parts):
            if start <= t <= end + HIT_TAIL_S:
                found[k] = True
                break
        else:
            stray += 1
    return sum(found), len(found), stray


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", type=Path, action="append", required=True, help="modelo .tflite (repetível)")
    p.add_argument(
        "--positive", action="append", default=[], metavar="DIR|ARQ:N", help="repetições da wake word (repetível)"
    )
    p.add_argument(
        "--negative", action="append", default=[], metavar="ARQ|DIR", help="áudio que NÃO deve disparar (repetível)"
    )
    p.add_argument(
        "--cutoffs",
        default=",".join(str(c) for c in DEFAULT_CUTOFFS),
        help="cutoffs a varrer, separados por vírgula",
    )
    p.add_argument("--top", type=int, default=10, help="lista os N falsos disparos de maior média (0 desliga)")
    p.add_argument("--top-cutoff", type=float, default=None, help="cutoff usado no --top (default: o maior varrido)")
    p.add_argument("--json", type=Path, default=None, help="grava o resultado completo neste arquivo")
    return p


def evaluate(args: argparse.Namespace) -> dict:
    cutoffs = sorted(float(c) for c in args.cutoffs.split(","))
    positives = [load_stream(s, positive=True) for s in args.positive]
    negatives = [load_stream(s, positive=False) for s in args.negative]
    for s in positives:
        n = s.expected if s.expected is not None else len(s.parts)
        log(f"[positivo] {s.label}: {n} repetição(ões), {s.seconds:.0f}s")
    for s in negatives:
        log(f"[negativo] {s.label}: {len(s.parts)} arquivo(s), {s.audio_seconds / 60:.1f} min")
    neg_hours = sum(s.audio_seconds for s in negatives) / 3600.0

    report = {"cutoffs": cutoffs, "negative_hours": round(neg_hours, 3), "models": {}}
    for model_path in args.model:
        outs = {id(s): raw_outputs(model_path, s.pcm) for s in positives + negatives}
        log(f"[modelo] {model_path.name}: inferência concluída")
        rows = []
        for cutoff in cutoffs:
            row = {"cutoff": cutoff, "positives": {}, "negatives": {}}
            hit_total = rep_total = stray_total = 0
            for s in positives:
                found, total, stray = score_positive(s, replay(*outs[id(s)], cutoff))
                row["positives"][s.label] = {"hits": found, "total": total, "stray": stray}
                hit_total += found
                rep_total += total
                stray_total += stray
            false_total = 0
            for s in negatives:
                hits = replay(*outs[id(s)], cutoff)
                hours = s.audio_seconds / 3600.0
                row["negatives"][s.label] = {
                    "false": len(hits),
                    "false_per_hour": round(len(hits) / hours, 2) if hours else None,
                    "files_with_false": len({s.part_index(t) for t, _m in hits}),
                    "files": len(s.parts),
                    "minutes": round(s.audio_seconds / 60, 2),
                    "where": [{"at": s.locate(t), "mean": round(m, 4)} for t, m in hits],
                }
                false_total += len(hits)
            row["hits"] = hit_total
            row["repetitions"] = rep_total
            row["recall"] = hit_total / rep_total if rep_total else None
            row["false"] = false_total
            row["false_per_hour"] = false_total / neg_hours if neg_hours else None
            row["stray_in_positives"] = stray_total
            rows.append(row)
        # Dois modelos com o mesmo nome (ex. work/hey_luna.tflite contra o
        # luna-firmware/models/hey_luna.tflite comunitário): o caminho desfaz.
        key = model_path.name if model_path.name not in report["models"] else str(model_path)
        report["models"][key] = rows
    return report


def print_report(report: dict, *, top: int, top_cutoff: float) -> None:
    hours = report["negative_hours"]
    print(f"\nNegativos: {hours * 60:.0f} min" if hours else "\nSem negativos")
    for name, rows in report["models"].items():
        print(f"\n== {name} ==")
        print(f"{'cutoff':>7} | {'recall':>12} | {'falsos':>6} | {'falsos/h':>8} | por conjunto")
        for row in rows:
            recall = f"{row['hits']}/{row['repetitions']} {100 * row['recall']:.0f}%" if row["repetitions"] else "-"
            fph = f"{row['false_per_hour']:.1f}" if row["false_per_hour"] is not None else "-"
            detail = ", ".join(
                f"{k}={v['false']}" + (f" ({v['files_with_false']}/{v['files']} arq.)" if v["files"] > 1 else "")
                for k, v in row["negatives"].items()
            )
            if row["stray_in_positives"]:
                detail += f" (+{row['stray_in_positives']} fora de hora nos positivos)"
            print(f"{row['cutoff']:>7} | {recall:>12} | {row['false']:>6} | {fph:>8} | {detail}")

        if top:
            top_row = min(rows, key=lambda r: abs(r["cutoff"] - top_cutoff))
            worst = sorted(
                (w for v in top_row["negatives"].values() for w in v["where"]),
                key=lambda w: -w["mean"],
            )[:top]
            if worst:
                print(f"  piores falsos em {top_row['cutoff']}:")
                for w in worst:
                    print(f"    {w['mean']:.3f}  {w['at']}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.positive and not args.negative:
        log("erro: passe pelo menos um --positive ou --negative")
        return 2
    try:
        report = evaluate(args)
    except ModelError as err:
        log(f"erro: {err}")
        return 2
    top_cutoff = args.top_cutoff if args.top_cutoff is not None else report["cutoffs"][-1]
    print_report(report, top=args.top, top_cutoff=top_cutoff)
    if args.json:
        args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        log(f"\nresultado completo em {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
