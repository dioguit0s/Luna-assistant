"""Testes de paridade de `detector.py` contra `WakeWord.cpp`.

Puro `unittest` + numpy — sem tflite, sem pymicro-features, sem I/O. Roda com:

    python -m unittest detector_test.py

Não existe convenção de teste Python no repo (o CI só cobre `luna-server/**`,
ver CLAUDE.md), então este arquivo é a referência de como rodar os do sidecar.
"""

from __future__ import annotations

import unittest

import numpy as np

from detector import FEATURE_SIZE, WakeDetector


class FakeModel:
    """Modelo streaming falso: devolve um uint8 fixo (ou uma sequência) por
    chamada e conta quantas vezes `reset()` foi invocado — o suficiente para
    verificar o protocolo de `detector.py` sem carregar um `.tflite`.
    """

    def __init__(self, raw_values=None, fixed_raw: int = 0):
        self._raw_values = list(raw_values) if raw_values is not None else None
        self._fixed_raw = fixed_raw
        self.infer_calls: list[np.ndarray] = []
        self.reset_calls = 0

    def infer(self, input_tensor: np.ndarray) -> int:
        self.infer_calls.append(input_tensor.copy())
        if self._raw_values is not None:
            return self._raw_values[len(self.infer_calls) - 1]
        return self._fixed_raw

    def reset(self) -> None:
        self.reset_calls += 1


def feature_slice(value: int) -> np.ndarray:
    """Uma fatia de 40 int8, todos com o mesmo valor — o conteúdo não importa
    para os testes de máquina de estados, só a identidade do slot."""
    return np.full(FEATURE_SIZE, value, dtype=np.int8)


class StrideGroupingTest(unittest.TestCase):
    def test_infers_once_per_stride_slices(self):
        model = FakeModel(fixed_raw=0)
        det = WakeDetector(stride=3, infer=model.infer, reset=model.reset)

        det.push_feature(feature_slice(1))
        det.push_feature(feature_slice(2))
        self.assertEqual(len(model.infer_calls), 0, "não deve inferir antes de 3 fatias")

        det.push_feature(feature_slice(3))
        self.assertEqual(len(model.infer_calls), 1, "deve inferir exatamente na 3ª fatia")

    def test_slices_land_in_correct_slot(self):
        model = FakeModel(fixed_raw=0)
        det = WakeDetector(stride=3, infer=model.infer, reset=model.reset)

        det.push_feature(feature_slice(10))
        det.push_feature(feature_slice(20))
        det.push_feature(feature_slice(30))

        sent = model.infer_calls[0]
        self.assertEqual(sent.shape, (1, 3, FEATURE_SIZE))
        self.assertTrue((sent[0, 0] == 10).all())
        self.assertTrue((sent[0, 1] == 20).all())
        self.assertTrue((sent[0, 2] == 30).all())

    def test_stride_one_infers_every_slice(self):
        model = FakeModel(fixed_raw=0)
        det = WakeDetector(stride=1, infer=model.infer, reset=model.reset)

        for i in range(4):
            det.push_feature(feature_slice(i))
        self.assertEqual(len(model.infer_calls), 4)


class SlidingWindowGateTest(unittest.TestCase):
    def _fire_after_settle(self, det: WakeDetector, model: FakeModel, raw: int, n: int):
        """Empurra `n` inferências de prob máxima depois do settle inicial."""
        for _ in range(det._settle_windows):  # noqa: SLF001 — teste de estado interno
            det.push_feature(feature_slice(0))
        results = []
        for _ in range(n):
            results.append(det.push_feature(feature_slice(0)))
        return results

    def test_nothing_fires_before_ring_is_full(self):
        model = FakeModel(fixed_raw=255)
        det = WakeDetector(stride=1, infer=model.infer, reset=model.reset, settle_windows=0)

        # As primeiras 4 inferências enchem o anel mas não completam 5 —
        # nenhuma pode disparar mesmo com prob 1.0.
        results = [det.push_feature(feature_slice(0)) for _ in range(4)]
        self.assertTrue(all(r is None for r in results))

    def test_settle_windows_swallow_initial_inferences_even_at_max_prob(self):
        model = FakeModel(fixed_raw=255)
        det = WakeDetector(stride=1, infer=model.infer, reset=model.reset)  # settle=15 default

        # As primeiras 15 inferências (SETTLE_WINDOWS) são engolidas pelo
        # cooldown de boot, mesmo com prob 1.0 e o anel cheio.
        results = [det.push_feature(feature_slice(0)) for _ in range(15)]
        self.assertTrue(all(r is None for r in results), "settle inicial deveria engolir tudo")

        # A 16ª já passou do settle e do preenchimento do anel (5 < 15).
        det16 = det.push_feature(feature_slice(0))
        self.assertIsNotNone(det16, "depois do settle e do anel cheio, deveria disparar")

    def test_strict_greater_than_mean_exactly_at_cutoff_does_not_fire(self):
        # raw/255 == 0.97 exatamente não existe em inteiros, então construímos
        # a média para bater exatamente no cutoff usando um raw calculado.
        cutoff = 0.5
        raw_at_cutoff = 128  # 128/255 ≈ 0.50196, ajusta abaixo para == exato
        # Usamos cutoff=0.5 e raw tal que prob == 0.5 exatamente: 255*0.5=127.5,
        # não é inteiro — em vez disso comparamos soma == cutoff*janela usando
        # um raw fixo e um cutoff derivado dele, para eliminar erro de ponto
        # flutuante do teste em si.
        raw = 100
        prob = raw / 255.0
        model = FakeModel(fixed_raw=raw)
        det = WakeDetector(
            stride=1,
            infer=model.infer,
            reset=model.reset,
            cutoff=prob,  # sum == cutoff * janela exatamente
            settle_windows=0,
        )

        results = [det.push_feature(feature_slice(0)) for _ in range(5)]
        self.assertTrue(
            all(r is None for r in results),
            "média == cutoff não deveria disparar (comparação é > estrito)",
        )

        # Um raw levemente maior já deve romper o limiar.
        model2 = FakeModel(fixed_raw=raw + 1)
        det2 = WakeDetector(
            stride=1, infer=model2.infer, reset=model2.reset, cutoff=prob, settle_windows=0
        )
        results2 = [det2.push_feature(feature_slice(0)) for _ in range(5)]
        self.assertTrue(any(r is not None for r in results2), "acima do cutoff deveria disparar")


class RefractoryAndRearmTest(unittest.TestCase):
    def test_refractory_blocks_for_rearm_windows_and_ring_keeps_filling(self):
        model = FakeModel(fixed_raw=255)
        det = WakeDetector(
            stride=1,
            infer=model.infer,
            reset=model.reset,
            settle_windows=0,
            rearm_windows=3,  # pequeno para o teste ser rápido
        )

        # Enche o anel e dispara.
        results = [det.push_feature(feature_slice(0)) for _ in range(5)]
        self.assertTrue(any(r is not None for r in results), "deveria ter disparado uma vez")

        # As próximas 3 inferências (REARM_WINDOWS) ficam no refratário, mesmo
        # com prob 1.0 — mas o anel continua sendo alimentado (não é resetado).
        blocked = [det.push_feature(feature_slice(0)) for _ in range(3)]
        self.assertTrue(all(r is None for r in blocked), "refratário deveria bloquear")
        self.assertAlmostEqual(det.mean_prob, 1.0, msg="anel deveria continuar cheio de 1.0")

        # A 4ª depois do disparo já passou do refratário e deve poder disparar
        # de novo (a média já está em 1.0 porque o anel nunca parou de encher).
        after = det.push_feature(feature_slice(0))
        self.assertIsNotNone(after, "depois do refratário deveria poder disparar de novo")

    def test_rearm_calls_reset_and_returns_to_settle(self):
        model = FakeModel(fixed_raw=255)
        det = WakeDetector(stride=1, infer=model.infer, reset=model.reset, settle_windows=2)

        det.rearm()
        self.assertEqual(model.reset_calls, 1)
        self.assertTrue(det.settling)

        # No settle, mesmo prob 1.0 não dispara.
        r1 = det.push_feature(feature_slice(0))
        r2 = det.push_feature(feature_slice(0))
        self.assertIsNone(r1)
        self.assertIsNone(r2)
        self.assertFalse(det.settling, "settle_windows=2 deveria ter acabado")


class DiagnosticsTest(unittest.TestCase):
    def test_max_mean_prob_and_window_ms_tracking(self):
        model = FakeModel(fixed_raw=0)
        det = WakeDetector(stride=3, infer=model.infer, reset=model.reset, settle_windows=0)

        for _ in range(5):
            det.push_feature(feature_slice(0))
            det.push_feature(feature_slice(0))
            det.push_feature(feature_slice(0))

        self.assertEqual(det.max_mean_prob, 0.0)
        # stride=3, FEATURE_STEP_MS=10 -> 30ms por janela de inferência.
        self.assertEqual(det.window_ms(50), 1500)
        self.assertEqual(det.window_ms(15), 450)


if __name__ == "__main__":
    unittest.main()
