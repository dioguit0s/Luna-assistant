"""Contrato do evento `score` do `wake_sidecar.py --stdin` (teste de mic do painel).

Roda o sidecar de verdade num subprocesso, com silêncio no stdin. Precisa do
modelo default no checkout (`luna-firmware/models/`); sem ele, pula — não é
isto que valida a detecção, só a cadência e a forma dos eventos.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from wake_sidecar import DEFAULT_MODEL

HERE = Path(__file__).resolve().parent
SILENCE_2S = bytes(2 * 16000 * 2)


def run_sidecar(*extra: str) -> list[dict]:
    proc = subprocess.run(
        [sys.executable, str(HERE / "wake_sidecar.py"), "--stdin", *extra],
        input=SILENCE_2S,
        capture_output=True,
        cwd=HERE,
        timeout=60,
    )
    return [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]


@unittest.skipUnless(Path(DEFAULT_MODEL).exists(), f"modelo ausente: {DEFAULT_MODEL}")
class ScoreEventTest(unittest.TestCase):
    def test_sem_flag_nao_emite_score(self):
        events = run_sidecar()
        self.assertNotIn("score", [e["event"] for e in events])

    def test_emite_score_na_cadencia_pedida(self):
        events = run_sidecar("--score-interval-ms", "500")
        scores = [e for e in events if e["event"] == "score"]
        # 2 s de áudio a cada 500 ms: 4 eventos (o último pode cair no limite).
        self.assertGreaterEqual(len(scores), 3)
        self.assertLessEqual(len(scores), 4)
        for event in scores:
            self.assertEqual(set(event), {"event", "audio_ms", "mean_prob"})
            self.assertGreaterEqual(event["mean_prob"], 0.0)
            self.assertLessEqual(event["mean_prob"], 1.0)
        gaps = [b["audio_ms"] - a["audio_ms"] for a, b in zip(scores, scores[1:])]
        self.assertTrue(all(gap >= 500 for gap in gaps), gaps)


if __name__ == "__main__":
    unittest.main()
