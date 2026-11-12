"""Confere os STLs na orientação de impressão: malha fechada e balanços acima de 45°.

  .venv\\Scripts\\python check_print.py
"""
from pathlib import Path

import numpy as np
import trimesh

MAX_OVERHANG_DEG = 45.0   # medido a partir da vertical
BRIDGE_OK_MM2 = 60.0      # tetos planos pequenos saem como ponte, sem suporte

for stl in sorted((Path(__file__).parent / "stl").glob("*.stl")):
    m = trimesh.load(stl, force="mesh")
    n, area, cz = m.face_normals, m.area_faces, m.triangles_center[:, 2]
    off_bed = cz > 0.05
    # ângulo da face em relação à vertical: 90° = teto plano
    ang = np.degrees(np.arcsin(np.clip(-n[:, 2], -1, 1)))
    steep = off_bed & (ang > MAX_OVERHANG_DEG + 0.5)
    flat = steep & (ang > 89)
    print(f"{stl.name:10s} fechada={m.is_watertight}  "
          f"inclinado>45°: {area[steep & ~flat].sum():6.1f} mm2  "
          f"tetos planos: {area[flat].sum():6.1f} mm2")
    # agrupa os tetos planos por altura para ver se são pontes curtas
    for z in np.unique(np.round(cz[flat], 1)):
        a = area[flat & (np.abs(cz - z) < 0.06)].sum()
        flag = "" if a < BRIDGE_OK_MM2 else "  <-- conferir"
        print(f"    teto em z={z:5.1f} mm: {a:6.1f} mm2{flag}")
