"""Extração de features — substituto do `audio_preprocessor_int8.tflite`.

O preprocessador do firmware roda inteiramente em kernels `tflite::tflm_signal`
(`SignalWindow`, `SignalFftAutoScale`, `SignalRfft`, `SignalFilterBank*`,
`SignalPcan`, `SignalFilterBankLog` — ver `luna-firmware/models/README.md`),
que só existem no runtime tflite-micro. Não há wheel de `tflite-micro`,
`tflite-runtime` nem `tensorflow` para Windows + Python 3.14 (verificado nesta
máquina em 2026-08-17), então carregar aquele `.tflite` aqui é beco sem saída —
ver ADR 004.

Em vez disso usamos `pymicro-features`, que é o mesmo micro frontend C++ do
tflite-micro, embalado como wheel abi3 standalone. Ele é a implementação exata
que o microWakeWord usou para gerar as features de TREINO dos modelos
vendorizados (`microwakeword/audio/audio_utils.py:generate_features_for_clip`,
`use_c=True`), então a paridade esperada é alta — mas não idêntica byte-a-byte
ao caminho `.tflite`, e a escala numérica da saída não é documentada como
constante pública. Ver `FEATURE_SCALE` abaixo.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import numpy as np
from pymicro_features import MicroFrontend

from detector import FEATURE_SIZE

# Quantum que o `pymicro_features` espera por chamada: 160 amostras (10ms a
# 16kHz) * 2 bytes/amostra. Mesmo valor de WAKE_STEP_SAMPLES no firmware
# (config.h) — não é coincidência, é o hop do frontend.
_STEP_BYTES = 160 * 2

# --- a única incógnita numérica deste sidecar ---
#
# `MicroFrontend.process_samples(...).features` devolve uma lista de 40
# inteiros, mas a escala não é documentada. Duas hipóteses, ambas plausíveis
# por leitura do código-fonte de referências diferentes do mesmo frontend:
#
#   1.0        — microwakeword/audio/audio_utils.py devolve os valores crus,
#                sem escalar, e microwakeword/inference.py quantiza para int8
#                direto com `data / input_scale + input_zero_point`
#                (scale≈0.10196, zp=-128) — o que implica faixa crua ~0..26.
#
#   1/25.6     — o micro_speech clássico do tflite-micro (mesma origem do
#                frontend) quantiza sua saída uint16 com
#                `(raw * 256 + 333) / 666 - 128`, o que implica faixa crua
#                0..666 e um pré-fator de 256/(666*... ) ~ 1/25.6 antes de
#                cair em 0..~26 também.
#
# Resolvida empiricamente (2026-08-17, `--feature-stats`, ver wake_sidecar.py):
# alimentando o `pymicro_features` com ruído branco moderado (fala real ainda
# não gravada nesta máquina), `result.features` chegou a max=25.78, p99=22.57 —
# bate com a hipótese 1 (faixa crua ~0..26), não com a 2 (~0..666). Quantizado
# com o scale/zero_point do `hey_luna_trained.tflite` (0.10196078568696976,
# -128), 26.0 vira int8 127 quase exato — a faixa do frontend cobre o int8
# quase inteiro sem escala nenhuma. Reconfirmar com fala real antes do M4; se
# o teto medido não bater com ~26, ver a nota de fallback abaixo (dump de
# features do firmware via WAKE_DUMP_FEATURES) antes de mudar esta constante.
FEATURE_SCALE = 1.0


@dataclass(frozen=True)
class Quantization:
    """Parâmetros de quantização int8 lidos do tensor de entrada do modelo
    streaming — não hardcoded, para não divergir se o `.tflite` for trocado
    (ver `models/hey_luna_trained.json` vs `okay_nabu.tflite`)."""

    scale: float
    zero_point: int

    def quantize(self, raw_features: np.ndarray) -> np.ndarray:
        """float cru do frontend -> int8 que o modelo streaming espera.

        Mesma fórmula que `microwakeword/inference.py` usa para alimentar o
        modelo streaming quantizado: `round(x / scale + zero_point)`, com
        `x = raw_features * FEATURE_SCALE` para resolver a incógnita acima.
        """
        scaled = raw_features.astype(np.float64) * FEATURE_SCALE
        quantized = np.round(scaled / self.scale + self.zero_point)
        return np.clip(quantized, -128, 127).astype(np.int8)


class MicroFeatures:
    """Envolve `pymicro_features.MicroFrontend` para consumir PCM16 cru e
    devolver fatias de 40 int8 já quantizadas, uma por 10ms de áudio — o
    equivalente do laço `feed()`/`runFeature()` do firmware, mas sem precisar
    reimplementar a janela deslizante de 480 amostras: o frontend já faz isso
    internamente.
    """

    def __init__(self, quantization: Quantization) -> None:
        self._frontend = MicroFrontend()
        self._quantization = quantization
        self._buffer = bytearray()

    def push_pcm(self, pcm_bytes: bytes) -> Iterator[np.ndarray]:
        """Alimenta PCM16LE mono 16kHz cru; produz 0+ fatias int8 prontas.

        Aceita blocos de qualquer tamanho (o chamador não precisa alinhar em
        640 bytes) — o resto fica em buffer para a próxima chamada, replicando
        a tolerância do `feed()` do firmware a blocos de tamanho arbitrário.
        """
        self._buffer.extend(pcm_bytes)
        idx = 0
        n = len(self._buffer)
        while idx + _STEP_BYTES <= n:
            result = self._frontend.process_samples(bytes(self._buffer[idx : idx + _STEP_BYTES]))
            idx += result.samples_read * 2
            if result.features:
                raw = np.array(result.features, dtype=np.float64)
                if raw.shape[0] != FEATURE_SIZE:
                    raise RuntimeError(
                        f"pymicro-features devolveu {raw.shape[0]} canais, "
                        f"esperava {FEATURE_SIZE}"
                    )
                yield self._quantization.quantize(raw)
        del self._buffer[:idx]

    def raw_feature_stats(self, pcm_bytes: bytes) -> tuple[float, float, float]:
        """min/max/mean das features CRUAS (antes de FEATURE_SCALE e da
        quantização) — o que `--feature-stats` usa para calibrar `FEATURE_SCALE`.
        Consome um `MicroFrontend` próprio para não perturbar o estado do que
        estiver em uso para detecção."""
        frontend = MicroFrontend()
        buffer = bytearray(pcm_bytes)
        idx = 0
        n = len(buffer)
        values: list[float] = []
        while idx + _STEP_BYTES <= n:
            result = frontend.process_samples(bytes(buffer[idx : idx + _STEP_BYTES]))
            idx += result.samples_read * 2
            if result.features:
                values.extend(result.features)
        if not values:
            return (0.0, 0.0, 0.0)
        arr = np.array(values, dtype=np.float64)
        return (float(arr.min()), float(arr.max()), float(arr.mean()))
