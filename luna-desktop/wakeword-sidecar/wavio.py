"""Leitura de `.wav` para PCM16 mono 16kHz cru.

Porta em numpy de `luna-client-test/src/wav.ts` (`readWavPcm16`,
`stereoToMono`, `resamplePcm16`) — mesma lógica, não reescrita: downmix por
média de canais, resample linear. Reusa `wave` da stdlib para o parsing do
container em vez do parser de chunks manual do TS, mas o formato de saída
(PCM16LE mono) e a lógica de conversão são as mesmas.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000


def read_wav_pcm16(path: Path) -> bytes:
    """Lê um `.wav` e devolve PCM16LE mono 16kHz cru, convertendo se preciso."""
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        frame_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width != 2:
        raise ValueError(
            f"{path}: {sample_width * 8} bits por amostra não suportado (só PCM16)"
        )

    samples = np.frombuffer(raw, dtype="<i2")

    if channels == 2:
        samples = samples.reshape(-1, 2).mean(axis=1).round().astype(np.int16)
    elif channels != 1:
        raise ValueError(f"{path}: {channels} canais não suportado (só mono/estéreo)")

    if frame_rate != SAMPLE_RATE:
        samples = _resample_linear(samples, frame_rate, SAMPLE_RATE)

    return samples.astype("<i2").tobytes()


def _resample_linear(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """Resample linear — mesma matemática de `resamplePcm16` em wav.ts:75-92,
    não uma técnica melhor: é só o que basta para uma fixture de calibração,
    não um resampler de produção."""
    n_in = samples.shape[0]
    ratio = from_rate / to_rate
    n_out = int(n_in / ratio)
    if n_out <= 0:
        return np.zeros(0, dtype=np.int16)

    src_pos = np.arange(n_out, dtype=np.float64) * ratio
    src_index = np.floor(src_pos).astype(np.int64)
    frac = src_pos - src_index

    idx0 = np.clip(src_index, 0, n_in - 1)
    idx1 = np.clip(src_index + 1, 0, n_in - 1)

    s0 = samples[idx0].astype(np.float64)
    s1 = samples[idx1].astype(np.float64)
    out = np.round(s0 + frac * (s1 - s0))
    return np.clip(out, -32768, 32767).astype(np.int16)


def feature_count_for_samples(n_samples: int, window_samples: int = 480, step_samples: int = 160) -> int:
    """Quantas fatias de features o frontend deveria emitir para N amostras —
    usado para checar a integração contra o `pymicro-features` real (ver
    `frontend_test.py`, roda só se as deps estiverem instaladas)."""
    if n_samples < window_samples:
        return 0
    return (n_samples - window_samples) // step_samples + 1


__all__ = ["read_wav_pcm16", "feature_count_for_samples", "SAMPLE_RATE"]
