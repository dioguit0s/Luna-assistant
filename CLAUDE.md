# Projeto Luna

Assistente de voz residencial: satélites ESP32-S3 (`luna-firmware`) falam por WebSocket com um orquestrador Node/TypeScript (`luna-server`), que conversa com Gemini Live ou OpenAI Realtime e aciona o Home Assistant. Meta de latência: TTFAB < 800 ms.

Arquitetura e decisões: [`docs/PROJETO LUNA.md`](docs/PROJETO%20LUNA.md) e [`docs/adr/`](docs/adr/). Consulte antes de mudar contrato de mensagem, adapter de áudio ou wake word.

## Revisão obrigatória

Depois de qualquer alteração de código, e **antes** de reportar a tarefa como concluída, despache o agente `luna-code-reviewer` e apresente os achados dele. Ele lê o diff, aplica os checklists do projeto e roda `tsc` + testes quando a mudança toca o servidor.

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

Treino de wake word (Docker):

```bash
bash wake-training/run.sh all
```

## Pegadinhas do repositório

- **O script `test` do `luna-server` lista os arquivos um a um, sem glob.** Todo `*.test.ts` novo precisa ser adicionado manualmente ao `package.json`, senão nunca roda — nem local, nem no CI.
- **O CI só cobre `luna-server/**`.** Firmware, ESPHome e wake-training não têm portão automático; a revisão é o único filtro.
- **Contrato WS vive em dois lugares.** `luna-server/src/ws/protocol.ts` e `luna-firmware/src/ws/`. Mudar um sem o outro é regressão silenciosa.
- **`.env` no Windows:** editar com `Get-Content | Set-Content` no PowerShell 5.1 corrompe acentos. Use o editor ou `-Encoding utf8` explícito.
- **`luna-firmware/include/secrets.h` e `luna-firmware-actuator/secrets.yaml` nunca vão para o commit.**
