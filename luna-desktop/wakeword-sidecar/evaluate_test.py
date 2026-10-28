"""Testes da régua de `evaluate.py` — a parte pura (replay, contagem de
acertos, atribuição de disparo a arquivo). Sem modelo nem áudio real: as
saídas cruas do modelo entram prontas, como `raw_outputs()` as devolveria.

    python -m unittest evaluate_test.py
"""

from __future__ import annotations

import unittest

from detector import FEATURE_STEP_MS, SETTLE_WINDOWS, SLIDING_WINDOW, WakeDetector
from evaluate import HIT_TAIL_S, Stream, replay, score_positive

STRIDE = 3
INFER_S = STRIDE * FEATURE_STEP_MS / 1000.0  # 30 ms por inferência


def burst_at(n: int, starts: list[int], length: int = 8, value: int = 255) -> list[int]:
    """`n` saídas zeradas com rajadas de `value` começando em cada índice."""
    out = [0] * n
    for s in starts:
        for i in range(s, min(n, s + length)):
            out[i] = value
    return out


class ReplayTest(unittest.TestCase):
    def test_replay_matches_live_detector(self):
        # Mesmas saídas, mesmo cutoff: o replay tem que disparar nas mesmas
        # inferências que o WakeDetector alimentado ao vivo — é a premissa de
        # varrer cutoffs sem rodar o modelo de novo.
        outputs = burst_at(400, [50, 120, 300], length=10, value=250)
        it = iter(outputs)
        live = WakeDetector(stride=STRIDE, infer=lambda _t: next(it), reset=lambda: None, cutoff=0.95)
        live.rearm()
        live_hits = []
        for _ in range(len(outputs) * STRIDE):
            det = live.push_feature([0] * 40)
            if det is not None:
                live_hits.append(det.inference)
        hits = replay(outputs, STRIDE, 0.95)
        self.assertEqual([round(t / INFER_S) for t, _ in hits], live_hits)
        self.assertEqual(len(hits), 3)

    def test_cutoff_above_output_never_fires(self):
        outputs = burst_at(200, [50], value=250)  # 250/255 ~ 0.980
        self.assertEqual(len(replay(outputs, STRIDE, 0.97)), 1)
        self.assertEqual(replay(outputs, STRIDE, 0.99), [])

    def test_settle_swallows_burst_at_start(self):
        # Igual ao boot do firmware: rajada antes do fim do settle não dispara.
        outputs = burst_at(200, [0], length=SETTLE_WINDOWS - SLIDING_WINDOW)
        self.assertEqual(replay(outputs, STRIDE, 0.5), [])


class ScorePositiveTest(unittest.TestCase):
    def test_count_mode_caps_at_expected(self):
        s = Stream(label="x", pcm=b"", expected=3)
        hits = [(1.0, 1.0), (2.0, 1.0), (3.0, 1.0), (4.0, 1.0)]
        self.assertEqual(score_positive(s, hits), (3, 3, 1))
        self.assertEqual(score_positive(s, hits[:2]), (2, 3, 0))

    def test_per_clip_mode_matches_hits_to_clips(self):
        parts = [(1.0, 1.8, "a.wav"), (4.8, 5.6, "b.wav"), (8.6, 9.4, "c.wav")]
        s = Stream(label="dir", pcm=b"", parts=parts)
        hits = [
            (1.9, 1.0),  # a, logo depois do fim
            (5.6 + HIT_TAIL_S, 1.0),  # b, no limite da cauda
            (7.5, 1.0),  # entre b e c: fora de hora
        ]
        self.assertEqual(score_positive(s, hits), (2, 3, 1))

    def test_two_hits_on_same_clip_count_once(self):
        s = Stream(label="dir", pcm=b"", parts=[(1.0, 1.8, "a.wav")])
        self.assertEqual(score_positive(s, [(1.5, 1.0), (2.2, 1.0)]), (1, 1, 0))


class LocateTest(unittest.TestCase):
    def setUp(self):
        self.s = Stream(label="neg", pcm=b"", parts=[(0.0, 10.0, "a.wav"), (10.2, 20.0, "b.wav")])

    def test_inside_file(self):
        self.assertEqual(self.s.locate(3.25), "a.wav @ 3.2s")
        self.assertEqual(self.s.locate(15.0), "b.wav @ 4.8s")

    def test_hit_right_after_previous_file_is_attributed_to_it(self):
        self.assertEqual(self.s.locate(10.5), "a.wav @ 10.5s (fim)")
        self.assertEqual(self.s.part_index(10.5), 0)
        self.assertEqual(self.s.part_index(15.0), 1)

    def test_audio_seconds_excludes_inserted_silence(self):
        self.assertAlmostEqual(self.s.audio_seconds, 19.8)


if __name__ == "__main__":
    unittest.main()
