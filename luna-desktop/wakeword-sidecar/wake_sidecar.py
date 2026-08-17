#!/usr/bin/env python
"""Sidecar de wake word — marco 3 do `luna-desktop`.

Modo M3 (este marco): roda isolado, recebe um ou mais `.wav`, imprime a
detecção e diagnóstico. Modo M4 (próximo marco, já implementado aqui porque a
CLI é o mesmo binário): `--stdin` lê PCM16LE 16kHz mono cru do stdin e emite
eventos conforme detecta — é o que o Electron vai `child_process.spawn`.

Contrato de saída: **stdout só tem JSON, uma linha por evento** (contrato que
o M4 vai parsear). Todo log humano, `--trace` e `--feature-stats` vão para
stderr. Ver README.md deste diretório para o esquema de cada evento.

    python wake_sidecar.py --wav fixtures/silence.wav --trace
    python wake_sidecar.py --stdin < mic.pcm
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from detector import DEFAULT_CUTOFF, WakeDetector
from frontend import MicroFeatures, Quantization
from model import ModelError, load_model
from wavio import read_wav_pcm16

# O console do Windows costuma estar em cp1252/cp850, não UTF-8. stdout já é
# só ASCII (json.dumps default), mas stderr carrega acentos em pt-BR — sem
# isto, um `log()` com "inferências" ou "detecção" derruba o processo com
# UnicodeEncodeError em vez de só imprimir errado.
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = SCRIPT_DIR / ".." / ".." / "luna-firmware" / "models" / "hey_luna_trained.tflite"

# Frames de 640 bytes = 20ms a 16kHz mono — o mesmo quantum que o renderer do
# luna-desktop entrega (`shared/pcm.ts: CHUNK_BYTES`). Alimentar em blocos
# desse tamanho no `--wav` faz o caminho de teste ser idêntico ao do M4.
CHUNK_BYTES = 640

# Um gap de alimentação maior que isto no modo `--stdin` é tratado como uma
# pausa (mic mudo, app suspenso) e dispara `rearm()` automaticamente — a
# mesma lógica do firmware, que rearma na borda de reentrada em IDLE
# (main.cpp:158-186), sem precisar de um canal de controle separado.
DEFAULT_REARM_GAP_MS = 300


def emit(event: dict) -> None:
    """Escreve um evento JSON em stdout, uma linha, com flush imediato."""
    sys.stdout.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"caminho do .tflite streaming (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--threshold",
        "--cutoff",
        dest="threshold",
        type=float,
        default=DEFAULT_CUTOFF,
        help=f"cutoff de probabilidade média (default: {DEFAULT_CUTOFF}, calibrado no INMP441)",
    )
    parser.add_argument(
        "--wav",
        action="append",
        type=Path,
        default=None,
        metavar="FILE",
        help="processa um .wav (repetível — cada arquivo é um clipe independente, com rearm entre eles)",
    )
    parser.add_argument("--stdin", action="store_true", help="lê PCM16LE 16kHz mono cru do stdin (modo M4)")
    parser.add_argument("--trace", action="store_true", help="stderr: probabilidade de cada inferência")
    parser.add_argument(
        "--feature-stats",
        action="store_true",
        help="stderr: min/max/média das features cruas do frontend (calibração de FEATURE_SCALE)",
    )
    parser.add_argument(
        "--rearm-gap-ms",
        type=int,
        default=DEFAULT_REARM_GAP_MS,
        help=f"no --stdin, gap de alimentação (ms) que dispara rearm automático (default: {DEFAULT_REARM_GAP_MS})",
    )
    return parser


def run_clip(
    pcm: bytes,
    *,
    detector: WakeDetector,
    features: MicroFeatures,
    trace: bool,
    label: str,
) -> dict:
    """Alimenta um clipe PCM16 completo em blocos de CHUNK_BYTES e devolve o
    resumo (`eof`). Usado tanto pelo modo `--wav` quanto, clipe a clipe, pelo
    laço de stdin."""
    detections = []
    audio_ms = 0.0
    ms_per_byte = 1000.0 / (2 * 16000)  # 2 bytes/amostra, 16000 amostras/s

    for offset in range(0, len(pcm), CHUNK_BYTES):
        chunk = pcm[offset : offset + CHUNK_BYTES]
        audio_ms += len(chunk) * ms_per_byte
        for feature_slice in features.push_pcm(chunk):
            inferences_before = detector.inferences
            detection = detector.push_feature(feature_slice)
            # push_feature só roda uma inferência a cada `stride` fatias — não
            # logar nas fatias intermediárias, senão a mesma inferência
            # aparece repetida no trace (uma vez por fatia de 10ms).
            if trace and detector.inferences != inferences_before:
                log(
                    f"[{label}] inf={detector.inferences:05d} "
                    f"audio_ms={audio_ms:8.1f} last_prob={detector.last_prob:.3f} "
                    f"mean={detector.mean_prob:.3f} settling={detector.settling}"
                )
            if detection is not None:
                detections.append(detection)
                emit(
                    {
                        "event": "wake",
                        "label": label,
                        "audio_ms": round(audio_ms, 1),
                        "prob": round(detection.prob, 4),
                        "mean_prob": round(detection.mean_prob, 4),
                        "inference": detection.inference,
                    }
                )
                log(
                    f"[{label}] DETECTADO em audio_ms={audio_ms:.1f} "
                    f"(média {detection.mean_prob:.3f})"
                )

    return {
        "event": "eof",
        "label": label,
        "audio_ms": round(audio_ms, 1),
        "inferences": detector.inferences,
        "max_mean_prob": round(detector.max_mean_prob, 4),
        "detections": len(detections),
    }


def cmd_wav(args: argparse.Namespace) -> int:
    try:
        loaded = load_model(args.model)
    except ModelError as err:
        emit({"event": "error", "message": str(err)})
        return 2

    quantization: Quantization = loaded.quantization
    log(
        f"[wake_sidecar] modelo={loaded.path.name} sha256={loaded.sha256[:12]}… "
        f"stride={loaded.stride} scale={quantization.scale:.6f} zp={quantization.zero_point} "
        f"threshold={args.threshold}"
    )
    emit(
        {
            "event": "ready",
            "model": loaded.path.name,
            "model_sha256": loaded.sha256,
            "stride": loaded.stride,
            "threshold": args.threshold,
            "input_scale": quantization.scale,
            "input_zero_point": quantization.zero_point,
        }
    )

    exit_code = 0
    for wav_path in args.wav:
        try:
            pcm = read_wav_pcm16(wav_path)
        except (ValueError, FileNotFoundError, OSError) as err:
            emit({"event": "error", "label": wav_path.name, "message": str(err)})
            exit_code = 2
            continue

        if args.feature_stats:
            probe = MicroFeatures(quantization)
            lo, hi, mean = probe.raw_feature_stats(pcm)
            log(f"[{wav_path.name}] features cruas: min={lo:.3f} max={hi:.3f} mean={mean:.3f}")

        detector = WakeDetector(stride=loaded.stride, infer=loaded.infer, reset=loaded.reset, cutoff=args.threshold)
        features = MicroFeatures(quantization)
        # Cada arquivo é um clipe independente: rearma antes de processar,
        # exercitando o mesmo caminho que o M4 vai percorrer entre um "hey
        # luna" e o próximo (settle de novo, ring limpo).
        detector.rearm()

        summary = run_clip(pcm, detector=detector, features=features, trace=args.trace, label=wav_path.name)
        emit(summary)
        log(
            f"[{wav_path.name}] {summary['inferences']} inferências, "
            f"{summary['detections']} detecção(ões), "
            f"prob média máx={summary['max_mean_prob']}"
        )

    return exit_code


def cmd_stdin(args: argparse.Namespace) -> int:
    try:
        loaded = load_model(args.model)
    except ModelError as err:
        emit({"event": "error", "message": str(err)})
        return 2

    quantization = loaded.quantization
    detector = WakeDetector(stride=loaded.stride, infer=loaded.infer, reset=loaded.reset, cutoff=args.threshold)
    features = MicroFeatures(quantization)

    emit(
        {
            "event": "ready",
            "model": loaded.path.name,
            "model_sha256": loaded.sha256,
            "stride": loaded.stride,
            "threshold": args.threshold,
            "input_scale": quantization.scale,
            "input_zero_point": quantization.zero_point,
        }
    )
    log(f"[wake_sidecar] pronto — lendo PCM16 cru do stdin (modelo={loaded.path.name})")

    stdin = sys.stdin.buffer
    audio_ms = 0.0
    ms_per_byte = 1000.0 / (2 * 16000)
    last_frame_at = time.monotonic()
    gap_s = args.rearm_gap_ms / 1000.0

    while True:
        chunk = stdin.read(CHUNK_BYTES)
        if not chunk:
            break

        now = time.monotonic()
        if now - last_frame_at > gap_s:
            log(f"[wake_sidecar] gap de {int((now - last_frame_at) * 1000)}ms detectado — rearm automático")
            detector.rearm()
        last_frame_at = now

        audio_ms += len(chunk) * ms_per_byte
        for feature_slice in features.push_pcm(chunk):
            inferences_before = detector.inferences
            detection = detector.push_feature(feature_slice)
            if args.trace and detector.inferences != inferences_before:
                log(
                    f"inf={detector.inferences:05d} audio_ms={audio_ms:8.1f} "
                    f"last_prob={detector.last_prob:.3f} mean={detector.mean_prob:.3f}"
                )
            if detection is not None:
                emit(
                    {
                        "event": "wake",
                        "audio_ms": round(audio_ms, 1),
                        "prob": round(detection.prob, 4),
                        "mean_prob": round(detection.mean_prob, 4),
                        "inference": detection.inference,
                    }
                )
                log(f"DETECTADO em audio_ms={audio_ms:.1f} (média {detection.mean_prob:.3f})")

    emit({"event": "eof", "audio_ms": round(audio_ms, 1), "inferences": detector.inferences})
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.stdin and args.wav:
        print("erro: --stdin e --wav são exclusivos", file=sys.stderr)
        return 2
    if not args.stdin and not args.wav:
        print("erro: passe --wav FILE (repetível) ou --stdin", file=sys.stderr)
        return 2

    if args.stdin:
        return cmd_stdin(args)
    return cmd_wav(args)


if __name__ == "__main__":
    raise SystemExit(main())
