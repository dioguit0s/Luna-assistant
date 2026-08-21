# Projeto Luna

Assistente de voz residencial: satélites ESP32-S3 (`luna-firmware`) falam por WebSocket com um orquestrador Node/TypeScript (`luna-server`), que conversa com Gemini Live ou OpenAI Realtime e aciona o Home Assistant. Meta de latência: TTFAB < 800 ms.

Arquitetura e decisões: [`docs/PROJETO LUNA.md`](docs/PROJETO%20LUNA.md) e [`docs/adr/`](docs/adr/). Consulte antes de mudar contrato de mensagem, adapter de áudio ou wake word.

Referência por tarefa:

- Mexer em mensagem entre satélite e servidor → [`docs/protocolo-websocket.md`](docs/protocolo-websocket.md) (fonte canônica do contrato)
- Mexer no código do servidor → [`docs/arquitetura-servidor.md`](docs/arquitetura-servidor.md) (mapa dos módulos)
- Montar ambiente ou tarefa comum → [`docs/onboarding.md`](docs/onboarding.md)
- Navegar tudo → [`README.md`](README.md) e [`docs/Home.md`](docs/Home.md)

## Revisão de codigo

Toda vez que for pedida uma revisao de codigo, despache o agente `luna-code-reviewer` e apresente os achados dele. Ele lê o diff, aplica os checklists do projeto e roda `tsc` + testes quando a mudança toca o servidor.

Não é o caso quando: a mudança é só documentação, comentário ou Markdown; ou o usuário pediu para pular a revisão.

O revisor só reporta — as correções são suas. Apresente os achados junto com o que você fez, não em vez disso.

## Comandos

`luna-server` (TypeScript, Node ≥20, ESM):

```bash
cd luna-server && npm test
```

```bash
cd luna-server && npx tsc --noEmit
```

`luna-firmware` (PlatformIO, ESP32-S3):

```bash
cd luna-firmware && pio run
```

Sidecar de wake word do `luna-desktop` (Python, venv em `luna-desktop/wakeword-sidecar/.venv`):

```bash
cd luna-desktop && npm run test:wakeword
```

Treino de wake word (Docker):

```bash
bash wake-training/run.sh all
```

## Pegadinhas do repositório

- **O script `test` do `luna-server` lista os arquivos um a um, sem glob.** Todo `*.test.ts` novo precisa ser adicionado manualmente ao `package.json`, senão nunca roda — nem local, nem no CI.
- **O CI só cobre `luna-server/**`.** Firmware, ESPHome e wake-training não têm portão automático; a revisão é o único filtro.
- **Contrato WS vive em quatro lugares.** `luna-server/src/ws/protocol.ts`, `luna-firmware/src/ws/`, `luna-desktop/src/main/ws/protocol.ts` e `luna-client-test/src/protocol.ts`. Não há gerador nem teste cruzado: mudar um sem os outros é regressão silenciosa. Checklist e referência canônica em [`docs/protocolo-websocket.md`](docs/protocolo-websocket.md).
- **O preprocessador de wake word (`.tflite`) não roda fora do tflite-micro** (ops customizadas `tflm_signal`). O `luna-desktop` usa `pymicro-features` em vez dele — duas implementações de extração de features (`luna-firmware/src/wake/WakeWord.cpp` e `luna-desktop/wakeword-sidecar/frontend.py`) que precisam ficar em sincronia; mudar uma sem revisar a outra é a mesma classe de regressão silenciosa do contrato WS. Ver [ADR 004](docs/adr/004-wake-word-no-desktop.md).
- **`.env` no Windows:** editar com `Get-Content | Set-Content` no PowerShell 5.1 corrompe acentos. Use o editor ou `-Encoding utf8` explícito.
- **`luna-server/deploy/luna-server.service` não é reinstalada pelo deploy automático.** `activate.sh` só copia `dist/` e `config/` para a release; a unit em `/etc/systemd/system/` só muda com `sudo cp` + `daemon-reload` manuais no servidor (ver `deploy/README.md`). Mudar a unit sem repetir esse passo já queimou um deploy inteiro (`StateDirectory` novo, unit velha sem ele, `ProtectSystem=strict` sem diretório gravável nenhum) — `activate.sh` agora falha rápido com `cmp` se detectar a divergência, mas o passo manual continua sendo responsabilidade de quem mexe na unit.
- **`luna-firmware/include/secrets.h` e `luna-firmware-actuator/secrets.yaml` nunca vão para o commit.**
