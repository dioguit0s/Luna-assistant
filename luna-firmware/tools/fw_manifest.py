#!/usr/bin/env python3
"""Gera o manifest.json de uma release de firmware (ADR 012).

O servidor (luna-server/src/ota/firmwareReleases.ts) lê este arquivo da release
no GitHub e confere o `firmware.bin` baixado contra `size` e `sha256` antes de
servir ao satélite; o satélite confere de novo enquanto grava.

Uso:
  python tools/fw_manifest.py --bin firmware.bin --version 0.6.0 \\
      --build abc1234 --commit <sha completo> --changelog-file notas.txt \\
      --out manifest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_FIRMWARE_BYTES = 0x680000
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bin", required=True, type=Path)
    p.add_argument("--version", required=True)
    p.add_argument("--build", required=True, help="SHA curto (7) — o FW_BUILD embutido")
    p.add_argument("--commit", default=None, help="SHA completo do commit da tag")
    p.add_argument("--changelog-file", type=Path, default=None)
    p.add_argument("--out", required=True, type=Path)
    a = p.parse_args()

    if not SEMVER.match(a.version):
        sys.exit(f"versão inválida: {a.version!r} (semver, sem o prefixo fw-v)")
    if not SHA.match(a.build) or len(a.build) != 7:
        sys.exit(f"build inválido: {a.build!r} (7 hex)")
    if a.commit and not SHA.match(a.commit):
        sys.exit(f"commit inválido: {a.commit!r}")

    data = a.bin.read_bytes()
    if not 0 < len(data) <= MAX_FIRMWARE_BYTES:
        sys.exit(f"binário de {len(data)} bytes fora do limite da partição OTA")

    changelog = ""
    if a.changelog_file and a.changelog_file.exists():
        changelog = a.changelog_file.read_text(encoding="utf-8").strip()[:2000]

    manifest = {
        "version": a.version,
        "build": a.build,
        "commit": a.commit,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "changelog": changelog,
    }
    a.out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in manifest.items() if k != "changelog"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
