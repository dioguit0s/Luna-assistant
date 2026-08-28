# Projeto Luna

Assistente de voz residencial, self-hosted e de baixa latência. Satélites ESP32-S3
espalhados pela casa escutam a wake word **"Hey Luna"** localmente, transmitem áudio
por WebSocket para um orquestrador Node/TypeScript, que conversa com **Gemini Live**
ou **OpenAI Realtime** (áudio→áudio, sem STT/TTS intermediários) e aciona o
**Home Assistant**.

**Meta de performance:** TTFAB (*Time-To-First-Audio-Byte*) < 800 ms — do último byte
de áudio enviado pelo cliente até o primeiro chunk de resposta recebido de volta.

```
┌──────────────┐   WebSocket    ┌─────────────────┐   WS/SDK    ┌──────────────┐
│ Satélite     │  PCM16 16kHz   │  luna-server    │  áudio↔áudio│ Gemini Live  │
│ ESP32-S3     │ ──────────────>│  (orquestrador) │────────────>│ OpenAI Realt.│
│ wake word    │<────────────── │                 │<────────────│              │
│ local        │  audio_response│                 │             └──────────────┘
└──────────────┘                └────────┬────────┘
                                         │ REST/WS (function calling)
┌──────────────┐                         v
│ luna-desktop │                ┌─────────────────┐    ┌──────────────────────┐
│ (Windows)    │───────────────>│ Home Assistant  │───>│ luna-firmware-actuator│
└──────────────┘                └─────────────────┘    │ (ESPHome, relés)      │
                                                       └──────────────────────┘
```

## Por onde começar

| Se você quer… | Leia |
|---|---|
| Entender a arquitetura e as decisões | [`docs/PROJETO LUNA.md`](docs/PROJETO%20LUNA.md) |
| Montar o ambiente e rodar tudo | [`docs/onboarding.md`](docs/onboarding.md) |
| Mexer em mensagens entre satélite e servidor | [`docs/protocolo-websocket.md`](docs/protocolo-websocket.md) |
| Mexer no código do servidor | [`docs/arquitetura-servidor.md`](docs/arquitetura-servidor.md) |
| Saber *por que* algo foi decidido assim | [`docs/adr/`](docs/adr/) |
| Navegar tudo (vault Obsidian) | [`docs/Home.md`](docs/Home.md) |

## Componentes

| Diretório | O que é | Stack | Docs |
|---|---|---|---|
| [`luna-server/`](luna-server/) | Orquestrador central: WebSocket, sessões por cômodo, providers de IA, function calling, alarmes | Node ≥22.5, TypeScript, ESM | [README](luna-server/README.md) · [arquitetura](docs/arquitetura-servidor.md) · [deploy](luna-server/deploy/README.md) |
| [`luna-firmware/`](luna-firmware/) | Firmware do satélite: captura I2S, wake word on-device, playback, FSM | ESP32-S3, C++/PlatformIO | [README](luna-firmware/README.md) · [pinagem](docs/PINAGEM_EPICO_2.md) |
| [`luna-desktop/`](luna-desktop/) | Satélite para Windows: mesmo protocolo, wake word em sidecar Python | Electron, TypeScript, Python | [README](luna-desktop/README.md) · [plano](docs/luna-desktop.md) |
| [`luna-firmware-actuator/`](luna-firmware-actuator/) | Atuador físico (relés) exposto ao Home Assistant | ESPHome (YAML) | [README](luna-firmware-actuator/README.md) |
| [`luna-client-test/`](luna-client-test/) | Cliente de bancada: fala o protocolo pelo microfone do PC ou por WAV | Node, TypeScript | [README](luna-client-test/README.md) |
| [`infra/`](infra/) | Home Assistant via Docker Compose | Docker | [README](infra/README.md) |
| [`wake-training/`](wake-training/) | Pipeline de treino do modelo "Hey Luna" (microWakeWord) | Docker, Python | [README](wake-training/README.md) |
| [`docs/`](docs/) | Vault Obsidian: arquitetura, ADRs, planos de feature | Markdown | [Home](docs/Home.md) |

> `luna-affine-mcp/` existe no disco de um experimento abandonado, está **vazio e
> fora do controle de versão**. Não é parte do sistema.

## Quick start (só o servidor, sem hardware)

Suficiente para falar com a Luna pelo microfone do PC em menos de 5 minutos.

```bash
cd luna-server && cp .env.example .env && npm install
```

Preencha `GEMINI_API_KEY` e `WS_AUTH_SECRET` no `.env`, e suba o servidor:

```bash
cd luna-server && npm run dev
```

Em outro terminal, suba o cliente de bancada e fale:

```bash
cd luna-client-test && npm install && npm run dev:mic
```

Os logs do servidor trazem `ttfab` por turno. Passo a passo completo (incluindo
firmware, Home Assistant e desktop) em [`docs/onboarding.md`](docs/onboarding.md).

## Comandos por componente

`luna-server` — testes e type-check:

```bash
cd luna-server && npm test
```

```bash
cd luna-server && npx tsc --noEmit
```

`luna-firmware` — build:

```bash
cd luna-firmware && pio run
```

`luna-desktop` — testes do sidecar de wake word:

```bash
cd luna-desktop && npm run test:wakeword
```

`wake-training` — treino completo do modelo:

```bash
bash wake-training/run.sh all
```

## Estado do projeto

| Épico | Escopo | Estado |
|---|---|---|
| 1 — Cérebro | Servidor, providers, ring buffer, cliente de bancada | Entregue |
| 2 — Satélite | Hardware, firmware, I2S, FSM, AEC | Entregue |
| 3 — Automação | Home Assistant, ESPHome, function calling | Entregue |
| 4 — Autonomia | Wake word on-device, multi-satélite, fan-out por sala | Entregue (Redis pendente) |
| — Alarmes e lembretes | SQLite, scheduler, ciclo de toque, fala pré-renderizada | Implementado — falta calibrar os tempos de rajada no hardware ([plano](docs/alarmes-e-lembretes.md)) |
| — luna-desktop | Satélite Windows | Entregue |

## Convenções do repositório

- **Idioma:** documentação, comentários e mensagens de commit em **português**.
- **Segredos:** `luna-server/.env`, `luna-firmware/include/secrets.h` e
  `luna-firmware-actuator/secrets.yaml` **nunca** vão para o commit.
- **Decisões arquiteturais** viram ADR em [`docs/adr/`](docs/adr/), a partir do
  [template](docs/adr/_template.md).
- **Revisão de código:** o agente `luna-code-reviewer` é despachado a cada mudança
  de código — ver [`CLAUDE.md`](CLAUDE.md).
- **CI:** só cobre `luna-server/**` (testes + build + deploy no push em `main`).
  Firmware, ESPHome e wake-training não têm portão automático.

Armadilhas conhecidas do repositório estão listadas em [`CLAUDE.md`](CLAUDE.md) —
leia antes do primeiro commit.

## Licença

MIT — ver [`LICENSE`](LICENSE).
