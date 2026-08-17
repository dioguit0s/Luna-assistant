"""Detecção de wake word — paridade com `luna-firmware/src/wake/WakeWord.cpp`.

Este módulo é puro de propósito: não carrega modelo, não abre arquivo e não
importa tflite. A inferência entra como callable, então `detector_test.py` roda
sem nenhuma dependência além do numpy.

A ordem das operações em `push_feature()` é copiada de `runFeature()`
(WakeWord.cpp:294-368) porque cada detalhe dela é observável: empilhar a
probabilidade *antes* de checar o refratário, comparar a *soma* com
`cutoff * janela` (e não a média com o cutoff), usar `>` estrito. Mudar
qualquer um desloca o cutoff calibrado no satélite.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Sequence

import numpy as np

# Espelham `luna-firmware/include/config.h:66-91`. O contrato do wake word vive
# nos dois lugares (mesma classe de pegadinha do protocolo WS descrito no
# CLAUDE.md): mudar aqui sem mudar lá faz o desktop e o satélite discordarem
# sobre o que é um "Hey Luna".
FEATURE_SIZE = 40  # WAKE_FEATURE_SIZE — canais por fatia
SLIDING_WINDOW = 5  # WAKE_SLIDING_WINDOW — média móvel sobre N inferências
REARM_WINDOWS = 50  # WAKE_REARM_WINDOWS — refratário depois de disparar
SETTLE_WINDOWS = 15  # WAKE_SETTLE_WINDOWS — cooldown depois de rearm()/boot
DEFAULT_CUTOFF = 0.97  # WAKE_PROB_CUTOFF

# Cada fatia de features cobre 10 ms de áudio (WAKE_FEATURE_STEP_MS), e o modelo
# só é invocado a cada `stride` fatias — daí a conversão de "janelas de
# inferência" (a unidade dos contadores acima) para tempo.
FEATURE_STEP_MS = 10


@dataclass(frozen=True)
class Detection:
    """Um disparo de wake word."""

    mean_prob: float  # média das últimas SLIDING_WINDOW probabilidades
    prob: float  # probabilidade da inferência que fechou o gatilho
    inference: int  # índice da inferência (1-based), para correlacionar com o trace


class WakeDetector:
    """Máquina de inferência do wake word.

    `infer` recebe o tensor `[1, stride, FEATURE_SIZE]` int8 e devolve o uint8
    cru (0..255) do modelo. `reset` limpa os *variable tensors* do modelo
    streaming — no firmware é `streamInterp->Reset()`, no LiteRT é
    `interpreter.reset_all_variables()`. Ele é obrigatório aqui, e não opcional,
    porque é carga-crítica: sem reset o modelo continua "quente" depois de uma
    pausa na alimentação e volta a disparar sozinho com a saída presa em 255
    (ver o comentário de `rearm()` em WakeWord.cpp:406-413).
    """

    def __init__(
        self,
        *,
        stride: int,
        infer: Callable[[np.ndarray], int],
        reset: Callable[[], None],
        cutoff: float = DEFAULT_CUTOFF,
        sliding_window: int = SLIDING_WINDOW,
        rearm_windows: int = REARM_WINDOWS,
        settle_windows: int = SETTLE_WINDOWS,
    ) -> None:
        if stride < 1:
            raise ValueError(f"stride precisa ser >= 1, recebi {stride}")
        if sliding_window < 1:
            raise ValueError(f"sliding_window precisa ser >= 1, recebi {sliding_window}")

        self._stride = stride
        self._infer = infer
        self._reset = reset
        self._cutoff = cutoff
        self._sliding_window = sliding_window
        self._rearm_windows = rearm_windows
        self._settle_windows = settle_windows

        # Zerado, como a arena do TFLM no boot do firmware.
        self._input = np.zeros((1, stride, FEATURE_SIZE), dtype=np.int8)
        self._stride_step = 0
        self._probs = [0.0] * sliding_window
        self._prob_index = 0
        self._prob_filled = 0
        # `begin()` do firmware chama `rearm()`, então o detector nasce em
        # cooldown de acomodação — não em zero.
        self._ignore_windows = settle_windows

        # Diagnóstico (equivalente ao que o `debugSnapshot()` do firmware loga).
        self.inferences = 0
        self.last_prob = 0.0
        self.max_mean_prob = 0.0

    # --- propriedades de leitura ---

    @property
    def stride(self) -> int:
        return self._stride

    @property
    def cutoff(self) -> float:
        return self._cutoff

    @property
    def settling(self) -> bool:
        """True enquanto o refratário/cooldown está engolindo as inferências."""
        return self._ignore_windows > 0

    @property
    def mean_prob(self) -> float:
        """Média móvel atual. Só é comparável ao cutoff quando o anel está cheio."""
        return sum(self._probs) / self._sliding_window

    def window_ms(self, windows: int) -> int:
        """Converte janelas de inferência em milissegundos, dado o stride."""
        return windows * self._stride * FEATURE_STEP_MS

    # --- alimentação ---

    def push_feature(self, features: Sequence[int] | np.ndarray) -> Optional[Detection]:
        """Empilha uma fatia de 40 int8 e, se fechou o stride, roda a inferência.

        Devolve a `Detection` quando dispara, senão None. Espelha `runFeature()`
        (WakeWord.cpp:294-368) a partir do ponto em que as features já existem.
        """
        # Grupos NÃO sobrepostos: a fatia vai para o slot `stride_step` e a
        # inferência só roda quando os `stride` slots foram preenchidos. O
        # histórico mais longo vive dentro do modelo (variable tensors), não
        # aqui — é por isso que `reset` importa tanto.
        self._input[0, self._stride_step] = features
        self._stride_step += 1
        if self._stride_step < self._stride:
            return None
        self._stride_step = 0

        raw = self._infer(self._input)
        # Saída uint8 0..255 -> probabilidade. Divisão crua por 255, sem usar
        # scale/zero_point do tensor: é o que o firmware faz (WakeWord.cpp:338)
        # e o que a calibração do cutoff assumiu.
        prob = raw / 255.0
        self.last_prob = prob
        self.inferences += 1

        # A probabilidade entra no anel ANTES da checagem de refratário: durante
        # o cooldown o anel continua enchendo, e é isso que faz a média já estar
        # quente quando o refratário acaba.
        self._probs[self._prob_index] = prob
        self._prob_index = (self._prob_index + 1) % self._sliding_window
        if self._prob_filled < self._sliding_window:
            self._prob_filled += 1

        if self._ignore_windows > 0:
            self._ignore_windows -= 1
            return None
        if self._prob_filled < self._sliding_window:
            return None

        total = sum(self._probs)
        mean = total / self._sliding_window
        if mean > self.max_mean_prob:
            self.max_mean_prob = mean

        # `>` estrito sobre a soma, exatamente como WakeWord.cpp:363.
        if total > self._cutoff * self._sliding_window:
            self._ignore_windows = self._rearm_windows
            return Detection(mean_prob=mean, prob=prob, inference=self.inferences)
        return None

    def rearm(self) -> None:
        """Devolve o detector a frio. Espelha `rearm()` (WakeWord.cpp:406-424).

        Não zera o estado do micro frontend: o firmware também não, porque o
        preprocessador readapta sozinho com o áudio novo.
        """
        self._reset()
        self._probs = [0.0] * self._sliding_window
        self._prob_index = 0
        self._prob_filled = 0
        self._ignore_windows = self._settle_windows
        self._stride_step = 0
        self.last_prob = 0.0
