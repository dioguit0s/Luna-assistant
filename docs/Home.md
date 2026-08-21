# Luna — Índice

Nota de entrada do vault. Abra `docs/` no Obsidian e fixe esta nota (⭐) para achar
tudo em um clique. O front door do repositório é o [README da raiz](../README.md).

## Comece por aqui

- [Onboarding](onboarding.md) — do repositório clonado até acender uma luz por voz
- [PROJETO LUNA](PROJETO%20LUNA.md) — visão geral, arquitetura de referência, decisões

## Referência técnica

- [Protocolo WebSocket](protocolo-websocket.md) — **fonte canônica** do contrato de
  mensagens entre satélites e servidor
- [Arquitetura do servidor](arquitetura-servidor.md) — mapa dos módulos do `luna-server`
- [PINAGEM_EPICO_2](PINAGEM_EPICO_2.md) — GPIOs, montagem e armadilhas de hardware

## ADRs

- [ADR 001 — Audio provider abstraction](adr/001-audio-provider-abstraction.md)
- [ADR 002 — Function calling contract](adr/002-function-calling-contract.md)
- [ADR 003 — Wake word engine](adr/003-wake-word-engine.md)
- [ADR 004 — Wake word no desktop](adr/004-wake-word-no-desktop.md)

Previstos e ainda não escritos: **005** (persistência no `luna-server`), **006**
(agendamento server-side e contrato de tempo), **007** (áudio não solicitado e
endereçamento por sala).

## Features / módulos

- [Alarmes e lembretes](alarmes-e-lembretes.md) — plano e decisões; marcos 0 a 6 entregues
- [luna-desktop](luna-desktop.md) — satélite para Windows

## READMEs por componente

Ficam junto do código, não no vault:

- [`luna-server`](../luna-server/README.md) · [deploy](../luna-server/deploy/README.md)
- [`luna-firmware`](../luna-firmware/README.md) · [modelos](../luna-firmware/models/README.md)
- [`luna-desktop`](../luna-desktop/README.md) · [sidecar de wake word](../luna-desktop/wakeword-sidecar/README.md)
- [`luna-firmware-actuator`](../luna-firmware-actuator/README.md)
- [`luna-client-test`](../luna-client-test/README.md)
- [`infra`](../infra/README.md)
- [`wake-training`](../wake-training/README.md)

## Convenções

**Novas ADRs:** use o template [adr/_template](adr/_template.md) (Templates core
plugin, pasta de templates = `docs/adr`). Numeração sequencial, `Status` em
Proposto/Aceito/Rejeitado/Substituído.

**Notas de arquitetura e referência** vivem aqui em `docs/`. **Instruções de uso de um
componente** vivem no README dele, junto do código. Quando as duas coisas se
sobrepõem, o vault referencia o README — não duplica.

**Armadilhas do repositório** (contrato em quatro cópias, script de teste sem glob, CI
parcial, encoding de `.env` no Windows) estão em [`CLAUDE.md`](../CLAUDE.md).
