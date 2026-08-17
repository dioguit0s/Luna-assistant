"""Carregamento e validação do modelo streaming (`hey_luna_trained.tflite`,
`okay_nabu.tflite`, ...) via `ai-edge-litert`, sucessor mantido do
`tflite-runtime` — ver ADR 004 para por que não é `tflite-runtime` nem
`tensorflow`.

O preprocessador NÃO passa por aqui: `frontend.py` (via `pymicro-features`)
substitui `audio_preprocessor_int8.tflite`, que não carrega neste runtime.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter

from detector import FEATURE_SIZE
from frontend import Quantization


class ModelError(RuntimeError):
    """Geometria do modelo não bate com o contrato do wake word (ver
    `luna-firmware/models/README.md`) — falha alto e claro em vez de produzir
    probabilidades sem sentido."""


@dataclass(frozen=True)
class LoadedModel:
    path: Path
    sha256: str
    stride: int
    quantization: Quantization
    interpreter: Interpreter
    input_index: int
    output_index: int

    def infer(self, input_tensor: np.ndarray) -> int:
        """Roda uma inferência e devolve o uint8 cru (0..255), sem dequantizar
        — igual a `WakeWord.cpp:337-338`."""
        self.interpreter.set_tensor(self.input_index, input_tensor)
        self.interpreter.invoke()
        raw = self.interpreter.get_tensor(self.output_index)
        return int(raw.reshape(-1)[0])

    def reset(self) -> None:
        """Limpa os variable tensors do modelo streaming — equivalente a
        `streamInterp->Reset()` (WakeWord.cpp:413). Ver o comentário em
        `detector.py` sobre por que isto é carga-crítica."""
        self.interpreter.reset_all_variables()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_model(path: Path) -> LoadedModel:
    """Carrega e valida o modelo streaming.

    Validação espelha `checkTensor()` do firmware (WakeWord.cpp, seção de
    boot): entrada `[1, stride, FEATURE_SIZE]` int8, saída de 1 elemento
    uint8. O `stride` é lido do tensor (`dims[1]`), nunca hardcoded — modelos
    diferentes usam strides diferentes (`hey_luna_trained`/`okay_nabu` = 3,
    os `hey_luna` comunitários = 2).
    """
    if not path.exists():
        raise ModelError(f"modelo não encontrado: {path}")

    interpreter = Interpreter(model_path=str(path))
    interpreter.allocate_tensors()

    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    if len(input_details) != 1 or len(output_details) != 1:
        raise ModelError(
            f"{path.name}: esperava 1 entrada e 1 saída, "
            f"achei {len(input_details)} entrada(s) e {len(output_details)} saída(s)"
        )

    in_d, out_d = input_details[0], output_details[0]

    if in_d["dtype"] != np.int8 or len(in_d["shape"]) != 3:
        raise ModelError(
            f"{path.name}: entrada esperada int8 [1,stride,{FEATURE_SIZE}], "
            f"achei {in_d['dtype']} {list(in_d['shape'])}"
        )
    shape = in_d["shape"]
    if shape[0] != 1 or shape[2] != FEATURE_SIZE:
        raise ModelError(
            f"{path.name}: forma de entrada {list(shape)} não bate com "
            f"[1, stride, {FEATURE_SIZE}]"
        )
    stride = int(shape[1])
    if stride < 1:
        raise ModelError(f"{path.name}: stride inválido ({stride})")

    if out_d["dtype"] != np.uint8:
        raise ModelError(f"{path.name}: saída esperada uint8, achei {out_d['dtype']}")

    scale, zero_point = in_d["quantization"]
    if scale == 0:
        raise ModelError(f"{path.name}: entrada sem parâmetros de quantização (scale=0)")

    return LoadedModel(
        path=path,
        sha256=_sha256_file(path),
        stride=stride,
        quantization=Quantization(scale=float(scale), zero_point=int(zero_point)),
        interpreter=interpreter,
        input_index=in_d["index"],
        output_index=out_d["index"],
    )
