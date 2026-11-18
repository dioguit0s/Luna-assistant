#!/usr/bin/env python3
"""Guard de vazamento do binário de release (ADR 012).

O repositório é público e o `firmware.bin` publicado vai para qualquer um. Ele
não pode carregar Wi-Fi, IP do servidor, sala nem segredo — isso vive só na NVS
de cada satélite. Este script procura, byte a byte, valores que nunca deveriam
estar no binário e falha (exit 1) se achar algum:

  1. os valores de exemplo de include/secrets.h.example (se aparecem, o build
     usou o .example como secrets.h);
  2. os valores do include/secrets.h local, quando existe — para rodar na sua
     máquina antes de publicar qualquer binário à mão;
  3. a lista do ambiente FW_FORBIDDEN_STRINGS, um valor por linha (no CI, um
     secret do GitHub com o SSID, a senha, o IP do servidor e o segredo reais).

Também confere o tamanho contra a partição OTA (6,5 MB).

Uso:
  python tools/check_release_binary.py .pio/build/<env>/firmware.bin

Sem dependência fora da biblioteca padrão. Nunca imprime o valor achado — só o
nome da origem —, para o log do CI não virar o vazamento que ele evita.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_FIRMWARE_BYTES = 0x680000  # app0/app1 de default_16MB.csv
# Valores que só a NVS pode ter. LUNA_WS_PATH fica fora: "/" está em todo binário.
DEFINE_KEYS = ("WIFI_SSID", "WIFI_PASS", "LUNA_HOST", "ROOM_ID", "WS_AUTH_SECRET")
# Curto demais gera falso positivo (qualquer "sala" casaria em texto do próprio
# firmware); 4 caracteres ainda pega senha e SSID reais na prática.
MIN_LEN = 4

DEFINE_RE = re.compile(r'^\s*#\s*define\s+(\w+)\s+"((?:[^"\\]|\\.)*)"', re.MULTILINE)


def defines(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    return {k: v for k, v in DEFINE_RE.findall(text) if k in DEFINE_KEYS}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    binary = Path(argv[1])
    data = binary.read_bytes()
    failures: list[str] = []

    if len(data) > MAX_FIRMWARE_BYTES:
        failures.append(f"binário de {len(data)} bytes maior que a partição OTA ({MAX_FIRMWARE_BYTES})")

    sources: list[tuple[str, str]] = []
    for key, value in defines(ROOT / "include" / "secrets.h.example").items():
        sources.append((f"secrets.h.example:{key}", value))
    for key, value in defines(ROOT / "include" / "secrets.h").items():
        sources.append((f"secrets.h:{key}", value))
    forbidden = [line.strip() for line in os.environ.get("FW_FORBIDDEN_STRINGS", "").splitlines()]
    for i, value in enumerate(v for v in forbidden if v):
        sources.append((f"FW_FORBIDDEN_STRINGS[{i}]", value))

    checked = 0
    for origin, value in sources:
        if len(value) < MIN_LEN:
            continue
        checked += 1
        if value.encode("utf-8") in data:
            failures.append(f"valor de {origin} encontrado no binário")

    if failures:
        for f in failures:
            print(f"::error::guard de vazamento: {f}")
        print("Binário RECUSADO: não publique. Ele precisa sair sem secrets.h (build genérico).")
        return 1

    print(f"guard de vazamento: ok ({len(data)} bytes, {checked} valores proibidos conferidos)")
    if not os.environ.get("FW_FORBIDDEN_STRINGS"):
        print("::warning::FW_FORBIDDEN_STRINGS vazio — só os placeholders do .example foram conferidos")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
