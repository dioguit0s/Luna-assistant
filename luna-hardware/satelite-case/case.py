"""
Luna — case do satélite (protótipo, puck redondo)

Envolve a placa-base de ../satelite-base/index.circuit.tsx (50 x 45 mm). As posições
de furo, USB-C, LED e botão abaixo são espelho daquele arquivo: mover um componente
na PCB sem mover aqui gera case que não fecha.

Quatro peças, todas sem suporte em FDM:
  base.stl    — fundo, apoios da PCB, nicho do cabo USB-C        (imprime como está)
  anel.stl    — anel difusor de luz (filamento branco/translúcido) (imprime deitado)
  tampa.stl   — grelha do alto-falante, berço do microfone, guia do botão
                (exportada já de cabeça para baixo: face de cima na mesa)
  botao.stl   — botão do usuário, aciona o SW3                    (cabeça na mesa)

Ferragens: 4x M3x12 (fecham a case por baixo), 2x M3x6 (prendem a PCB). Os
parafusos abrem rosca direto no plástico.

Como rodar (Python 3.12 — o CadQuery não tem wheel para 3.13+):
  py -3.12 -m venv .venv
  .venv\\Scripts\\python -m pip install cadquery
  .venv\\Scripts\\python case.py
"""
import math
from pathlib import Path

import cadquery as cq

# ============================================================
# PARÂMETROS — tudo em mm
# ============================================================
# --- Corpo ---
outer_d = 96.0          # diâmetro externo do puck
wall = 2.0              # parede lateral
floor_t = 2.4           # fundo da base
top_t = 2.0             # espessura da face de cima (grelha)
base_h = 16.0           # altura da base (até o assento do anel)
ring_h = 6.0            # altura do vão do anel de luz
top_h = 22.0            # altura da tampa
bottom_chamfer = 2.0    # chanfro da borda de baixo
top_chamfer = 3.0       # chanfro da borda de cima (45°: imprime sem suporte)

# --- Anel difusor ---
ring_t = 1.6            # espessura radial do anel
ring_slack = 0.2        # folga vertical/radial do anel
lip_h = 1.2             # altura dos ressaltos que centram o anel
lip_t = 1.6             # espessura dos ressaltos

# --- PCB (espelho de satelite-base/index.circuit.tsx) ---
pcb_w, pcb_d, pcb_t = 50.0, 45.0, 1.6
pcb_off_y = -12.5       # PCB deslocada para trás: aproxima o USB-C da parede
pcb_standoff = 5.0      # vão sob a PCB (pinos das barras passam ~3 mm)
pcb_holes = [(-21.5, -19.0), (21.5, -19.0)]   # furos de 3,2 mm
pcb_front_rests = [(-20.0, 17.5), (20.0, 17.5)]  # apoios sem parafuso, lado da antena
usb_xy = (0.0, -22.5)   # boca do USB-C: assumida rente à borda de trás da PCB
led_xy = (0.0, -10.0)   # D1
sw3_xy = (15.0, -13.0)  # botão do usuário
sw_h = 1.5              # altura do TS-1187A acima da PCB

# --- USB-C ---
usb_open_w, usb_open_h = 9.6, 3.8   # abertura para o conector (8,94 x 3,26 + folga)
usb_axis_h = 1.6        # eixo do conector acima da face da PCB
usb_recess_w, usb_recess_h = 15.0, 8.0  # nicho para a capa do plugue (~12 x 6,5)
usb_wall_t = 1.0        # parede fina entre o nicho e a PCB
usb_gap = 0.4           # folga entre a borda da PCB e essa parede

# --- Alto-falante redondo de 40 mm ---
spk_d = 40.0
spk_clear = 0.3         # folga radial do berço
spk_ring_h = 5.0        # altura do colar que centra o alto-falante
spk_ring_t = 1.6
spk_rib = 0.35          # nervuras de esmagamento: seguram por pressão
spk_depth = 20.0        # profundidade assumida (só para checar colisão)
grille_r = 17.5         # raio da área furada
grille_hole_d = 1.8
grille_pitch = 1.55     # constante da espiral (maior = furos mais espaçados)

# --- Microfone INMP441 (módulo redondo de ~14 mm, em cabo curto) ---
mic_xy = (0.0, 33.0)    # na frente, longe do alto-falante
mic_d = 14.0
mic_clear = 0.4
mic_ring_h = 2.5
mic_ring_t = 1.2
mic_port_d = 2.0

# --- Botão ---
btn_cap_d = 9.0
btn_piston_d = 12.5
btn_piston_h = 8.0
btn_stem_d = 5.0
btn_clear = 0.3         # folga radial do botão
btn_proud = 1.0         # quanto a cabeça fica acima da tampa
btn_travel = 0.8        # folga acima do êmbolo (absorve variação da altura da chave)
btn_guide_h = 10.0
btn_guide_t = 1.6

# --- Parafusos ---
case_screw_r = 37.0                     # raio do círculo de parafusos
case_screw_angles = [40, 140, 205, 335]  # assimétrico: a tampa só entra de um jeito
m3_clear_d = 3.4
m3_pilot_d = 2.6        # M3 abrindo rosca no plástico
m3_head_d = 6.5
head_recess = 10.0      # rebaixo fundo: deixa usar M3x12 comum
base_boss_d = 9.5
top_boss_d = 8.0
top_pilot_depth = 12.0
pcb_boss_d = 7.0
pcb_pilot_depth = 6.0

# --- Pés de borracha adesivos ---
foot_d = 10.5
foot_depth = 1.0
foot_r = 32.0

eps = 0.01

# ============================================================
# COTAS DERIVADAS
# ============================================================
R = outer_d / 2
Ri = R - wall
z_ring0 = base_h
z_top0 = base_h + ring_h
H = z_top0 + top_h
z_plate = H - top_t                       # face interna da tampa
pcb_bot_z = floor_t + pcb_standoff
pcb_top_z = pcb_bot_z + pcb_t
lip_ro = R - ring_t - 2 * ring_slack      # raio externo dos ressaltos
lip_ri = lip_ro - lip_t


def P(xy):
    """Coordenada da PCB -> coordenada da case."""
    return (xy[0], xy[1] + pcb_off_y)


def polar(r, deg):
    a = math.radians(deg)
    return (r * math.cos(a), r * math.sin(a))


def revolve(points):
    return cq.Workplane("XZ").polyline(points).close().revolve(360, (0, 0, 0), (0, 1, 0))


def cyl(d, z0, z1, pts):
    return cq.Workplane("XY").workplane(offset=z0).pushPoints(pts).circle(d / 2).extrude(z1 - z0)


def box(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0, centered=False).translate((x0, y0, z0))


screw_pts = [polar(case_screw_r, a) for a in case_screw_angles]
pcb_edge_y = P(usb_xy)[1]
usb_cz = pcb_top_z + usb_axis_h
usb_face_y = pcb_edge_y - usb_gap           # face interna da parede do USB
usb_floor_y = usb_face_y - usb_wall_t       # fundo do nicho do plugue

assert math.hypot(pcb_w / 2, pcb_d / 2 - pcb_off_y) + 0.5 < lip_ri, "PCB não passa pela boca da base"

# ============================================================
# BASE
# ============================================================
base = revolve([
    (0, 0), (R - bottom_chamfer, 0), (R, bottom_chamfer), (R, base_h),
    (lip_ro, base_h), (lip_ro, base_h + lip_h), (lip_ri, base_h + lip_h),
    (lip_ri, base_h - 3.0), (Ri, base_h - 3.0 - (Ri - lip_ri)),   # rampa de 45° sob o ressalto
    (Ri, floor_t), (0, floor_t),
])
base_envelope = revolve([(0, 0), (R - bottom_chamfer, 0), (R, bottom_chamfer), (R, base_h), (0, base_h)])

# Maciço atrás da PCB, onde o nicho do cabo é escavado
usb_block = box(-usb_recess_w / 2 - 2, usb_recess_w / 2 + 2, -R, usb_face_y, 0, base_h).intersect(base_envelope)
base = base.union(usb_block)

# Apoios da PCB (dois com parafuso, dois só de encosto) e colunas dos parafusos da case
base = base.union(cyl(pcb_boss_d, floor_t - eps, pcb_bot_z, [P(h) for h in pcb_holes]))
base = base.union(cyl(6.0, floor_t - eps, pcb_bot_z, [P(r) for r in pcb_front_rests]))
base = base.union(cyl(base_boss_d, floor_t - eps, base_h, screw_pts))

# Cortes
base = base.cut(box(-usb_recess_w / 2, usb_recess_w / 2, -R - 1, usb_floor_y,
                    usb_cz - usb_recess_h / 2, usb_cz + usb_recess_h / 2))
base = base.cut(box(-usb_open_w / 2, usb_open_w / 2, usb_floor_y - eps, usb_face_y + eps,
                    usb_cz - usb_open_h / 2, usb_cz + usb_open_h / 2))
base = base.cut(cyl(m3_pilot_d, pcb_bot_z - pcb_pilot_depth, pcb_bot_z + eps, [P(h) for h in pcb_holes]))
base = base.cut(cyl(m3_head_d, -eps, head_recess, screw_pts))
base = base.cut(cyl(m3_clear_d, 0, base_h + eps, screw_pts))
base = base.cut(cyl(foot_d, -eps, foot_depth, [polar(foot_r, a) for a in (0, 90, 180, 270)]))

# ============================================================
# ANEL DIFUSOR
# ============================================================
ring = revolve([
    (R - ring_t, z_ring0), (R, z_ring0),
    (R, z_top0 - ring_slack), (R - ring_t, z_top0 - ring_slack),
])

# ============================================================
# TAMPA
# ============================================================
ci = top_chamfer + wall * 0.2   # chanfro interno acompanha o externo sem afinar a parede
top = revolve([
    (R, z_top0), (R, H - top_chamfer), (R - top_chamfer, H), (0, H),
    (0, z_plate), (Ri - ci, z_plate), (Ri, z_plate - ci),
    (Ri, z_top0 + 3.0 + (Ri - lip_ri)), (lip_ri, z_top0 + 3.0),   # rampa de 45° sobre o ressalto
    (lip_ri, z_top0 - lip_h), (lip_ro, z_top0 - lip_h), (lip_ro, z_top0),
])

spk_ri = spk_d / 2 + spk_clear
btn_xy = P(sw3_xy)
guide_id = btn_piston_d + 2 * btn_clear

# Colar do alto-falante + nervuras de esmagamento
top = top.union(cyl(2 * (spk_ri + spk_ring_t), z_plate - spk_ring_h, z_plate + eps, [(0, 0)])
                .cut(cyl(2 * spk_ri, z_plate - spk_ring_h - eps, z_plate, [(0, 0)])))
for a in range(0, 360, 60):
    rib = box(spk_ri - spk_rib, spk_ri + 0.5, -0.4, 0.4, z_plate - spk_ring_h, z_plate + eps)
    top = top.union(rib.rotate((0, 0, 0), (0, 0, 1), a + 15))

# Berço do microfone, guia do botão, colunas dos parafusos
mic_ri = mic_d / 2 + mic_clear
top = top.union(cyl(2 * (mic_ri + mic_ring_t), z_plate - mic_ring_h, z_plate + eps, [mic_xy]))
top = top.union(cyl(guide_id + 2 * btn_guide_t, z_plate - btn_guide_h, z_plate + eps, [btn_xy]))
top = top.union(cyl(top_boss_d, base_h, z_plate + eps, screw_pts))

# Cortes
top = top.cut(cyl(2 * mic_ri, z_plate - mic_ring_h - eps, z_plate, [mic_xy]))
top = top.cut(cyl(mic_port_d, z_plate - eps, H + eps, [mic_xy]))
top = top.cut(cyl(guide_id, z_plate - btn_guide_h - eps, z_plate, [btn_xy]))
top = top.cut(cyl(btn_cap_d + 2 * btn_clear, z_plate - eps, H + eps, [btn_xy]))
top = top.cut(cyl(m3_pilot_d, base_h - eps, base_h + top_pilot_depth, screw_pts))

# Grelha em espiral de girassol
grille_pts = [(0.0, 0.0)]
n = 1
while grille_pitch * math.sqrt(n) <= grille_r:
    grille_pts.append(polar(grille_pitch * math.sqrt(n), n * 137.508))
    n += 1
top = top.cut(cyl(grille_hole_d, z_plate - eps, H + eps, grille_pts))

# ============================================================
# BOTÃO
# ============================================================
sw_top_z = pcb_top_z + sw_h
piston_top_z = z_plate - btn_travel
btn_cone = (btn_piston_d - btn_cap_d) / 2   # cone de 45° entre cabeça e êmbolo: imprime sem suporte
button = revolve([
    (0, sw_top_z), (btn_stem_d / 2, sw_top_z),
    (btn_stem_d / 2, piston_top_z - btn_piston_h), (btn_piston_d / 2, piston_top_z - btn_piston_h),
    (btn_piston_d / 2, piston_top_z - btn_cone), (btn_cap_d / 2, piston_top_z),
    (btn_cap_d / 2, H + btn_proud), (0, H + btn_proud),
]).translate((btn_xy[0], btn_xy[1], 0))

# ============================================================
# CHECAGEM DE COLISÃO — maquete da eletrônica contra as peças
# ============================================================
def pcb_box(cx, cy, w, d, h):
    x, y = P((cx, cy))
    return box(x - w / 2, x + w / 2, y - d / 2, y + d / 2, pcb_top_z, pcb_top_z + h)


mock = {
    "PCB": box(-pcb_w / 2, pcb_w / 2, P((0, -pcb_d / 2))[1], P((0, pcb_d / 2))[1], pcb_bot_z, pcb_top_z),
    "ESP32-S3-WROOM": pcb_box(0, 5.5, 18.0, 25.5, 3.3),
    "barra J2 + módulo": pcb_box(-22, -2, 2.6, 15.3, 14.0),
    "barra J3 + módulo": pcb_box(22, -2, 2.6, 17.8, 14.0),
    "alto-falante": cyl(spk_d - 2 * spk_rib - 0.2, z_plate - spk_depth, z_plate, [(0, 0)]),
    "microfone": cyl(mic_d, z_plate - 4.0, z_plate, [mic_xy]),
}
parts = {"base": base, "anel": ring, "tampa": top, "botao": button}


def overlap(a, b):
    return a.val().intersect(b.val()).Volume()


problems = []
for mname, m in mock.items():
    for pname, p in parts.items():
        v = overlap(m, p)
        if v > 0.5:
            problems.append(f"{mname} x {pname}: {v:.1f} mm3")
names = list(parts)
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        v = overlap(parts[names[i]], parts[names[j]])
        if v > 0.5:
            problems.append(f"{names[i]} x {names[j]}: {v:.1f} mm3")

# ============================================================
# EXPORTAÇÃO — cada peça já na orientação de impressão
# ============================================================
out = Path(__file__).parent / "stl"
out.mkdir(exist_ok=True)


def flip(part, z_max):
    return part.rotate((0, 0, 0), (1, 0, 0), 180).translate((0, 0, z_max))


printable = {
    "base": base,
    "anel": ring.translate((0, 0, -z_ring0)),
    "tampa": flip(top, H),
    "botao": flip(button.translate((-btn_xy[0], -btn_xy[1], 0)), H + btn_proud),
}
step_out = Path(__file__).parent / "step"
step_out.mkdir(exist_ok=True)
for name, part in printable.items():
    cq.exporters.export(part, str(out / f"{name}.stl"), tolerance=0.01, angularTolerance=0.1)
    cq.exporters.export(part, str(step_out / f"{name}.step"))
    bb = part.val().BoundingBox()
    print(f"{name:6s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:5.1f} mm   {part.val().Volume() / 1000:6.1f} cm3")

# Corte da montagem (só para conferir visualmente; não é peça de impressão)
half = box(0, R + 5, -R - 5, R + 5, -5, H + 5).rotate((0, 0, 0), (0, 0, 1), -60)
section = cq.Workplane("XY")
for p in list(parts.values()) + list(mock.values()):
    section = section.add(p.cut(half).vals())
preview_dir = Path(__file__).parent / "preview"
preview_dir.mkdir(exist_ok=True)
cq.exporters.export(cq.Workplane("XY").add(cq.Compound.makeCompound(section.vals())),
                    str(preview_dir / "montagem_corte.stl"), tolerance=0.02, angularTolerance=0.2)

# Pacote para subir no serviço de impressão (STL + STEP das quatro peças)
import zipfile

with zipfile.ZipFile(Path(__file__).parent / "luna-satelite-case.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name in printable:
        z.write(out / f"{name}.stl", f"stl/{name}.stl")
        z.write(step_out / f"{name}.step", f"step/{name}.step")

print(f"Montado: diâmetro {outer_d:.0f} mm, altura {H:.0f} mm (+{btn_proud:.0f} do botão)")
print(f"Grelha: {len(grille_pts)} furos de {grille_hole_d} mm")
print("Colisões: " + ("nenhuma" if not problems else "; ".join(problems)))
