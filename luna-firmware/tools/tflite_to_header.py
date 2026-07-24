#!/usr/bin/env python3
"""Converte um .tflite num header C com o modelo embutido na flash.

O TFLite lê o modelo como um FlatBuffer direto do array, sem copiar — por isso o
array precisa de `alignas(16)`. Sem o alinhamento o `GetModel()` devolve lixo e o
`AllocateTensors()` falha com "Model provided is schema version 0".

Uso:
    python tools/tflite_to_header.py models/hey_luna_v3.tflite \
        src/wake/models/hey_luna_model_data.h g_hey_luna_model_data

Os headers gerados são commitados: o build não baixa nem converte nada.
"""

import pathlib
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2

    src = pathlib.Path(sys.argv[1])
    dst = pathlib.Path(sys.argv[2])
    symbol = sys.argv[3]

    data = src.read_bytes()
    guard = dst.name.upper().replace(".", "_").replace("-", "_")

    lines = [
        "// Gerado por tools/tflite_to_header.py — NÃO editar à mão.",
        f"// Origem: {src.as_posix()} ({len(data)} bytes)",
        "#pragma once",
        "",
        f"#ifndef {guard}",
        f"#define {guard}",
        "",
        f"alignas(16) const unsigned char {symbol}[] = {{",
    ]

    for i in range(0, len(data), 12):
        chunk = data[i : i + 12]
        lines.append("    " + " ".join(f"0x{b:02x}," for b in chunk))

    lines += [
        "};",
        f"const unsigned int {symbol}_len = {len(data)};",
        "",
        f"#endif // {guard}",
        "",
    ]

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text("\n".join(lines), encoding="utf-8")
    print(f"{dst} <- {src} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
