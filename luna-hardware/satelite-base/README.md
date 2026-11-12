# Placa-base do satélite (piloto)

Primeira PCB do Luna, descrita como código em [tscircuit](https://docs.tscircuit.com)
(TypeScript/TSX). Substitui a protoboard do Épico 2 mantendo **exatamente a mesma
pinagem** — o firmware atual roda sem mudança.

| | |
|---|---|
| Placa | 50 × 45 mm, 2 camadas, plano de GND nas duas faces |
| MCU | ESP32-S3-WROOM-1-**N16R8** (JLC C2913202), antena na borda superior |
| Alimentação | USB-C 5 V (CC1/CC2 com 5,1 kΩ) → AMS1117-3.3 (C6186) |
| USB | nativa (IO19 = D−, IO20 = D+), mesma porta do `pio upload`/monitor |
| UI | LED RGB S6-3528RGBTA (C2843672), botões RESET, BOOT (IO0) e USER (IO2) |
| Áudio | J2 → módulo INMP441 · J3 → módulo MAX98357A (barras fêmea 2,54 mm) |

## Pinagem — fonte única

Os GPIOs no topo de [`index.circuit.tsx`](index.circuit.tsx) espelham
[`luna-firmware/include/config.h`](../../luna-firmware/include/config.h) e
[`docs/PINAGEM_EPICO_2.md`](../../docs/PINAGEM_EPICO_2.md). Mudou um, muda os três.

| Sinal | GPIO | Conector |
|---|---|---|
| MIC SD / WS / SCK | 12 / 5 / 6 | J2: `VDD GND SD WS SCK LR` (LR → GND) |
| SPK DIN / BCLK / LRC | 7 / 16 / 17 | J3: `LRC BCLK DIN GAIN SD GND VIN` (VIN = 5 V) |
| LED R / G / B | 10 / 13 / 14 | 300 Ω / 100 Ω / 100 Ω, cátodo comum |
| Botão USER | 2 | pull-up interno |

> **Confira J3 contra o seu módulo antes de soldar.** A ordem segue a breakout
> MAX98357A mais comum (Adafruit), mas clones mudam a ordem. Se não bater, ligue
> por cabo ou ajuste `pinLabels` do J3.

## Fluxo de trabalho

Pré-requisitos (uma vez): Node, `npm i -g tscircuit bun`, KiCad 10 (para revisão).

```bash
bun install          # dependências do projeto
tsci build --pcb-png --schematic-png   # compila, roteia e gera dist/index/*.png
npm run check        # netlist, pinos, posicionamento, curtos, estilo
npm run export:kicad # ../build/satelite-base-fab/satelite-base-kicad.zip — abrir no KiCad
npm run export:gerbers
tsci dev             # visualização interativa; BOM + pick-and-place para a JLCPCB
```

**Visualizar no navegador:** rode `tsci build` e depois `tsci dev`, e abra
<http://localhost:3020/#file=dist%2Findex%2Fcircuit.json&main_component=dist%2Findex%2Fcircuit.json>.
Abra o `circuit.json` (o resultado do build), e não o `.tsx`: o visualizador
compila o `.tsx` com uma versão mais antiga do compilador (0.0.1745), que não
desenha a USB-C nem roteia, e mostra dezenas de erros falsos.

As exportações ficam em `luna-hardware/build/` (ignorado pelo git), fora do
pacote: se ficarem dentro, o `tsci dev` tenta carregar o zip do KiCad e os
modelos 3D, e trava em "Loading files…".

Mudanças passam pelo código: edite o `.tsx`, rode `tsci build`, confira os PNGs
e o `npm run check`. O Claude Code tem a skill `tscircuit` em
`.claude/skills/tscircuit` (instalada pelo `tsci init`).

### Revisão no KiCad (segunda opinião)

```bash
kicad-cli pcb drc --refill-zones --format json --severity-all -o drc.json ../build/satelite-base-kicad/index.circuit.kicad_pcb
```

Estado em 2026-11-11: 0 itens desconectados; 2 erros de `hole_clearance`
**dentro da pegada da USB-C** (pad de GND a 0,17 mm do furo-guia do próprio
conector — geometria padrão do footprint) e avisos cosméticos (altura de texto
de serigrafia, biblioteca `tscircuit` não cadastrada no KiCad).

## Antes de encomendar

- [ ] Conferir ordem do J3 com o módulo MAX98357A em mãos.
- [ ] Abrir o projeto no KiCad, dar `B` (recalcular zonas) e revisar o roteamento
      do USB (D+/D− estão roteados como sinais comuns, sem par diferencial
      controlado — aceitável para USB Full-Speed em trilhas curtas).
- [ ] Gerar BOM/CPL pelo `tsci dev` e conferir o estoque dos itens na JLCPCB
      (o build avisa "may not have availability" quando não consegue consultar).
- [ ] Revisar rotação do J3 no pick-and-place (o export avisou que não conseguiu
      verificar o pino 1 — barras de pinos costumam ser soldadas à mão).

## Próxima revisão (fora do piloto)

- Microfone e amplificador na própria placa (ICS-43434 / MAX98357A em QFN).
- Proteção ESD na USB (USBLC6-2SC6) e fusível/PTC no VBUS.
- Furos de fixação casando com o `luna-case`.
