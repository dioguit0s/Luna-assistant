# ADR 002 — Contrato de Function Calling Agnóstico ao Provider

**Status:** Aceito  
**Data:** 2026-07-19  
**Contexto:** Épico 3 — Automação Residencial

## Contexto

O Épico 3 exige que a Luna reconheça intenções de comando na fala ("Luna, ligar luz de teste") e as traduza em acionamentos no Home Assistant. A detecção dessa intenção não pode ser feita por casamento de padrões sobre a transcrição: o pipeline é audio-to-audio e a transcrição chega tarde demais, além de ser frágil a variações de fraseado.

Os dois providers suportados expõem function calling nativo, mas com formatos incompatíveis. O Gemini Live declara `tools: [{ functionDeclarations: [...] }]` na configuração da sessão e emite `message.toolCall` com uma lista de invocações, cada uma com seu `id`. A OpenAI Realtime declara `tools` de tipo `function` no `session.update` e emite o evento `response.function_call_arguments.done`, com `call_id` e os argumentos serializados como string JSON. Também divergem no caminho de retorno: o Gemini espera `sendToolResponse({ functionResponses })`, a OpenAI espera um `conversation.item.create` do tipo `function_call_output` seguido de `response.create`.

Deixar essa diferença vazar para o orquestrador reintroduziria exatamente o acoplamento que o [ADR 001](./001-audio-provider-abstraction.md) eliminou. O port `IAudioProvider`, porém, não tinha nem onde declarar as tools disponíveis nem por onde devolver o resultado da execução — e esse retorno é indispensável, pois é ele que faz a IA verbalizar a confirmação ao usuário em vez de encerrar o turno em silêncio.

## Decisão

Estender o port `IAudioProvider` com um canal de tools bidirecional, mantendo o contrato agnóstico: o orquestrador declara tools em JSON Schema, recebe invocações normalizadas e devolve resultados por `callId`. Cada adapter é responsável por traduzir esse contrato para o dialeto do seu SDK.

### Contrato do Port

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

interface ProviderSessionConfig {
  roomId: string;
  systemPrompt: string;
  history: ConversationTurn[];
  tools: ToolDefinition[];
}

interface IAudioProvider {
  connect(session: ProviderSessionConfig): Promise<void>;
  sendAudio(pcm16kHz: Buffer): void;
  signalActivityEnd(): void;
  onAudioResponse(callback: (chunk: Buffer) => void): void;
  onTurnComplete(callback: (turn: CompletedTurn) => void): void;
  onError(callback: (err: Error) => void): void;
  onToolCall(callback: (call: ToolCall) => void): void;
  sendToolResult(callId: string, result: unknown): void;
  disconnect(): Promise<void>;
}
```

`tools` é campo obrigatório de `ProviderSessionConfig`, não opcional: existe um único ponto de construção (`RoomManager.createProviderSession`) e a obrigatoriedade impede que uma sessão suba silenciosamente sem capacidade de automação.

`ToolCall.args` é tipado como `Record<string, unknown>` em vez de uma união discriminada por tool. Os argumentos são texto gerado por um modelo — fronteira de confiança, não payload estruturado — e tipá-los estaticamente no port daria uma falsa garantia além de acoplar o port a cada tool nova. A validação fica em type guards exportados junto de cada contrato de tool.

### Contrato da tool `control_device`

```json
{"function":"control_device","device":"luz_bancada","action":"on","room_id":"sala_de_estar"}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `device` | string | sim | Identificador do dispositivo, ex.: `luz_bancada` |
| `action` | `'on' \| 'off'` | sim | Estado desejado |
| `room_id` | string | sim | Área do Home Assistant, ex.: `sala_de_estar` |

A definição vive em `CONTROL_DEVICE_TOOL` (`luna-server/src/providers/types.ts`) e a validação em `isControlDeviceCall()`, no mesmo módulo.

`room_id` é declarado na tool para dar contexto ao modelo, mas **o orquestrador descarta o valor gerado e usa o `roomId` da sessão**. Validado em teste na LUNA-306: uma sessão em `sala_de_estar` produziu `room_id: "cozinha"`. O modelo não tem como saber de qual cômodo veio o áudio, e o valor alucinado passa pelo type guard sem erro — acionaria o dispositivo errado silenciosamente. O servidor conhece a origem do áudio com certeza; ela prevalece.

O `device` gerado pelo modelo **não vira `entity_id` por concatenação**. Desde a LUNA-309 ele é resolvido pelo `DeviceRegistry` (`luna-server/src/ha/deviceRegistry.ts`) contra o `room_id` da sessão: `("luz", "oficina")` e `("luz", "cozinha")` chegam a entidades diferentes, e o domínio (`switch`, `light`, `fan`) vem do próprio `entity_id`. Dispositivo não mapeado volta como `{ success: false, error }` com mensagem escrita para ser falada — "não encontrei o dispositivo X" — sem nenhuma chamada ao HA. Antes disso, um device alucinado virava um 404 no HA e a IA recebia um erro de HTTP para verbalizar.

O catálogo de dispositivos é **descoberto no próprio Home Assistant**, não declarado no repositório: `HomeAssistantClient.listAreaEntities()` renderiza `areas()`/`area_entities()` via `POST /api/template` no boot e revalida por TTL. Um mapa estático versionado obrigaria a cadastrar cada dispositivo novo duas vezes — no HA e no código — e a reiniciar o servidor; com a descoberta, atribuir a área no HA basta. `luna-server/config/devices.json` permanece só como camada de correção (apelidos, exclusões, entradas manuais). Falha de descoberta mantém o último snapshot: um HA momentaneamente fora do ar não pode apagar o vocabulário da Luna.

`room_id` segue os `area_id` do Home Assistant como fonte de verdade — `sala_de_estar`, `cozinha`, `quarto`, conforme [`infra/README.md`](../../infra/README.md). A mesma string atravessa todo o sistema sem tradução: `area_id` no HA, `ROOM_ID` no firmware, `room_id` no envelope WebSocket, chave de `ROOM_LABELS` no prompt e campo `room_id` desta tool. Qualquer ponto que invente um apelido próprio quebra a correlação silenciosamente, sem erro de compilação — cômodo novo se cria como área no HA primeiro, e o `area_id` gerado é replicado nos demais pontos.

### Responsabilidades por camada

| Camada | Responsabilidade |
|--------|------------------|
| Orchestrator | Executar a tool, emitir `command_result` ao satélite, devolver via `sendToolResult` |
| IAudioProvider (port) | Declaração de tools, normalização de invocações, retorno por `callId` |
| Adapters | Tradução para `functionDeclarations` / `tools`, parsing dos argumentos, formato de resposta do SDK |
| Contratos de tool | JSON Schema + type guard de validação dos argumentos gerados pelo LLM |

## Consequências

### Positivas

- O orquestrador declara e executa tools sem conhecer o provider ativo, preservando a troca por `.env` do Épico 1.
- `sendToolResult` fecha o ciclo e permite que a IA confirme o comando por voz no mesmo turno.
- Novas tools são adicionadas com uma constante `ToolDefinition` e um type guard, sem tocar no port nem nos adapters.
- A validação dos argumentos fica explícita e testável, isolada da lógica de despacho.

### Negativas

- `args` como `Record<string, unknown>` empurra a validação para runtime; esquecê-la é um erro silencioso que o compilador não pega.
- Correlação por `callId` exige que cada adapter mantenha o mapeamento para o identificador nativo do seu SDK.
- Um terceiro provider sem function calling nativo não conseguiria implementar o port sem emulação por prompt.

## Alternativas Consideradas

### Detecção de intenção por regex sobre a transcrição (rejeitada)

Casar padrões como `/lig(ar|a) (a )?luz/` no texto de `onTurnComplete`. Rejeitada por chegar depois da resposta em áudio já ter sido gerada, quebrando a confirmação verbal, e por ser frágil a qualquer variação de fraseado.

### Tools declaradas dentro de cada adapter (rejeitada)

Cada adapter conheceria `control_device` e a exporia ao seu SDK. Rejeitada por duplicar o contrato em dois lugares e garantir divergência entre eles ao longo do tempo.

### `ToolCall` como união discriminada por `name` (rejeitada)

Args tipados estaticamente por tool. Rejeitada por acoplar o port a cada tool nova e por prometer segurança de tipo sobre dados que só existem em runtime.

### Tool genérica `call_home_assistant` (adiada)

Uma única tool repassando `domain`/`service`/`entity_id` do HA. Adiada por expor a superfície inteira do Home Assistant ao modelo antes de existir qualquer camada de autorização; pode ser revisitada depois do Épico 3.

## Referências

- [PROJETO LUNA.md](../PROJETO%20LUNA.md) — Épico 3
- [ADR 001 — Abstração do Provedor de Áudio](./001-audio-provider-abstraction.md)
- [Gemini Live API — Tool use](https://ai.google.dev/gemini-api/docs/live-tools)
- [OpenAI Realtime API — Function calling](https://developers.openai.com/api/docs/guides/realtime-conversations)
