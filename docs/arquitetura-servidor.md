# Arquitetura do `luna-server`

Mapa do orquestrador central, como ele está construído hoje. Serve para achar o
módulo certo antes de mexer em qualquer coisa. Para o *porquê* das decisões, ver
[`PROJETO LUNA`](PROJETO%20LUNA.md) e [`adr/`](adr/); para o contrato de rede, ver
[`protocolo-websocket`](protocolo-websocket.md).

**Stack:** Node ≥ 22.5, TypeScript, ESM, ~10 kLOC. Quatro dependências de runtime:
`@google/genai`, `ws`, `pino`, `dotenv`. SQLite vem do `node:sqlite` embutido.

***

## Mapa de módulos

```
src/
├── index.ts              # boot: ordem de inicialização e shutdown
├── config/env.ts         # AppConfig — toda variável de ambiente passa aqui
├── logging/logger.ts     # pino, timestamp em America/Sao_Paulo
├── time/clock.ts         # relógio único do processo
├── ws/                   # camada de transporte
│   ├── WsServer.ts       #   servidor WS + HTTP /health, auth, fan-out por sala
│   ├── protocol.ts       #   envelope e tipos de mensagem
│   ├── messageParser.ts  #   split JSON|PCM do frame binário
│   └── auth.ts           #   HMAC-SHA256, comparação timing-safe
├── orchestrator/         # cérebro do turno
│   ├── Orchestrator.ts   #   fila de áudio, speaking_start/end, TTFAB, tools
│   └── tools/            #   handlers de function calling
├── rooms/                # estado por cômodo
│   ├── RoomManager.ts    #   ciclo de vida da sessão de provider
│   └── ConversationRingBuffer.ts  # histórico conversacional
├── providers/            # camada cognitiva
│   ├── IAudioProvider.ts #   interface que os adapters implementam
│   ├── types.ts          #   ToolDefinition, ToolCall, CompletedTurn
│   ├── AudioProviderFactory.ts
│   ├── gemini/           #   GeminiLiveAdapter + tool-mapping
│   ├── openai/           #   OpenAIRealtimeAdapter + tool-mapping
│   └── utils/resampler.ts#   24 kHz → 16 kHz
├── ha/                   # Home Assistant
│   ├── HomeAssistantClient.ts
│   ├── deviceRegistry.ts       # resolução dispositivo+cômodo → entity_id
│   └── deviceRegistrySource.ts # descoberta no HA + overrides do devices.json
├── reminders/            # alarmes e lembretes
│   ├── ReminderStore.ts  #   SQLite (node:sqlite)
│   ├── ReminderScheduler.ts # timer único auto-corretivo
│   ├── AlarmRinger.ts    #   ciclo de toque por sala: rajada/janela/dispensa
│   ├── resolveOnce.ts    #   "daqui a 20min" / "às 7" → instante
│   ├── recurrence.ts     #   "todo dia útil às 6:30" → próxima ocorrência
│   ├── spoken.ts         #   como um lembrete é dito em voz alta
│   ├── tools.ts          #   schema das duas tools de lembrete
│   └── chime.ts          #   PCM do toque, pré-renderizado
├── prompts/luna-system-prompt.ts  # personalidade + contexto de cômodo e hora
└── metrics/ttfab.ts      # medição da métrica de performance do projeto
```

***

## Boot (`index.ts`)

A ordem importa e é deliberada:

1. **Handlers de `unhandledRejection` / `uncaughtException`** — registrados antes de
   tudo. Uma rejeição que escapou dos `catch` do caminho crítico **não pode** derrubar
   o processo: isso mataria todos os cômodos, não só o que errou, e deixaria cada
   satélite mudo por até 20 s. Trade-off consciente e documentado no próprio arquivo.
2. **`loadConfig()`** — falha barulhenta se faltar variável obrigatória.
3. **`createLogger(config)`.**
4. **`ReminderStore.open(dbPath)`** — **antes de aceitar conexões**. Se o banco não
   abrir (permissão, corrupção, Node sem `node:sqlite`), o processo morre aqui, o
   health check do `activate.sh` falha e o rollback dispara. Um fallback silencioso
   para `:memory:` faria alarmes sumirem a cada deploy sem nenhum sinal.
5. **`ConversationRingBuffer` + `RoomManager`.**
6. **`HomeAssistantClient` + `DeviceRegistrySource`** — descobre os dispositivos antes
   de aceitar conexões.
7. **`WsServer.start()`.**

***

## Caminho de um turno

```
WsServer.handleMessage
   |
   v
Orchestrator.handleAudioChunk(roomId, deviceId, pcm)
   |
   +-> RoomManager.getOrCreateProvider(roomId)   # cria sessão se não existir
   |      |
   |      +-> AudioProviderFactory -> Gemini | OpenAI
   |      +-> bindProviderCallbacks(roomId, provider)
   |
   +-> provider.sendAudio(pcm)
          |
          | callbacks
          v
   onUserSpeech    -> TtfabTracker.markUserSpeech + debounce de silêncio
   onAudioResponse -> enqueueAudioFrames  (fila paceada por sala)
   onToolCall      -> dispatch por handler (controlDevice | setReminder)
   onTurnComplete  -> ConversationRingBuffer + enfileira speaking_end
   onError         -> speaking_end garantido
```

### `RoomManager`

Uma sessão de provider **por `room_id`**, criada sob demanda no primeiro áudio e
destruída quando o último satélite do cômodo desconecta.

O ponto delicado é `pendingConnections`: enquanto o `connect()` está em voo, todo
chunk seguinte recebe a **mesma** promise, para não abrir N sessões. Por isso existe
`PROVIDER_CONNECT_TIMEOUT_MS` (5 s) — num blackhole de rede (Wi-Fi de pé, internet
fora) a promise do SDK fica pendurada para sempre, e sem o teto a sala ficaria muda
até o processo reiniciar.

### `Orchestrator`

Guarda cinco mapas por sala: `ttfabByRoom`, `speakingByRoom`, `silenceTimerByRoom`,
`speakingWatchdogByRoom` e a fila de envio. `releaseRoom()` limpa todos — vazamento
aqui é vazamento de timer, que sobrevive à sala.

Responsabilidades:

- **Pacing da saída de áudio** e enfileiramento do `speaking_end` como último item.
- **Debounce de fim de fala** (`USER_SILENCE_CUTOFF_MS`) para antecipar o
  `speaking_start` sem esperar o modelo.
- **Watchdog de `speaking_end`** (`SPEAKING_WATCHDOG_MS`, 8 s).
- **Dispatch de tool calls** por handler, com `ToolContext` explícito.

Detalhes de temporização e as garantias de `speaking_end` estão em
[`protocolo-websocket`](protocolo-websocket.md#garantias-de-speaking_end).

***

## Providers

`IAudioProvider` isola o restante do sistema do SDK. Trocar de provider é mudar
`AUDIO_PROVIDER` no `.env` — sem refatoração. Ver [ADR 001](adr/001-audio-provider-abstraction.md).

| | Gemini | OpenAI |
|---|---|---|
| Adapter | `GeminiLiveAdapter` | `OpenAIRealtimeAdapter` |
| SDK | `@google/genai` | WebSocket direto |
| API | Live API | Realtime **GA** (`session.type: 'realtime'`) — a beta não serve |
| Endpointing | `GEMINI_VAD_*` | `OPENAI_VAD_TYPE` / `OPENAI_VAD_SILENCE_MS` |
| Particularidade | `thinkingBudget` (default `0`) | `OPENAI_VOICE` (default `marin`) |

Ambos entregam áudio a 24 kHz e reamostram para 16 kHz em `resample24kTo16k` antes de
chamar `onAudioResponse` — é o que mantém o contrato de rede simétrico.

Cada provider tem seu `tool-mapping.ts`, que traduz a `ToolDefinition` neutra para o
schema do SDK. As limitações de schema de cada API vivem ali, comentadas.

**Para comparar latência entre os dois de forma justa**, mantenha
`OPENAI_VAD_SILENCE_MS` igual a `GEMINI_VAD_SILENCE_MS`: a janela de endpointing entra
inteira no `ttfab`.

***

## Function calling

Contrato agnóstico ao provider — ver [ADR 002](adr/002-function-calling-contract.md).

| Tool | Handler | O que faz |
|---|---|---|
| `control_device` | `orchestrator/tools/controlDevice.ts` | Liga/desliga um dispositivo no HA e emite `command_result` |
| `set_reminder` | `orchestrator/tools/setReminder.ts` | Cria alarme/lembrete/timer, único ou recorrente |
| `manage_reminders` | `orchestrator/tools/manageReminders.ts` | `dismiss`/`snooze` do que toca agora, `list`/`cancel` do que está marcado |

**O vocabulário é deliberadamente enxuto por causa do TTFAB:** cada schema a mais infla
o `model_decision_ms`, sobretudo com `thinkingBudget: 0`. Adicionar tool é decisão de
latência, não só de feature.

**O `room_id` gerado pelo modelo é descartado.** O Orchestrator resolve o cômodo pela
conexão de onde o áudio veio. O prompt pede o campo só para reduzir alucinação — não
afrouxe o descarte com base no texto do prompt.

### Resolução de dispositivos

`DeviceRegistrySource` descobre o catálogo **no próprio Home Assistant** e revalida a
cada `DEVICE_REGISTRY_TTL_MS` (5 min): cadastrar um dispositivo no HA e atribuir uma
área o torna acionável no próximo refresh, sem editar arquivo nem reiniciar.

O `devices.json` (`DEVICES_CONFIG_PATH`) traz só **overrides**: apelidos que a IA tende
a falar, exclusões e entradas manuais.

`DeviceRegistry` em si é imutável e sem I/O. A chave é o par **`device` + `roomId`** —
o mesmo "luz" existe em vários cômodos apontando para entidades diferentes. Falhas de
resolução (`unknown_device`, `device_not_in_room`) trazem mensagem em português
**escrita para a IA falar em voz alta**.

***

## Tempo — um relógio só

`time/clock.ts` é a **única** fonte de "agora" do processo, fixada em
`America/Sao_Paulo` (offset -03:00 fixo; o Brasil aboliu o horário de verão em 2019).

Consumido por três lugares que **precisam concordar**:

- `logging/logger.ts` — timestamp dos logs;
- `prompts/luna-system-prompt.ts` — hora e período do dia no prompt;
- `reminders/` — resolução de "amanhã às 7".

A unit systemd não define `TZ=` e o CI também não. Sem esse módulo, num host UTC o
prompt diria a hora errada por 3 horas e os alarmes resolveriam 3 h fora. Corrigir só
o scheduler seria **pior** que o bug: o "agora" do modelo e o do servidor passariam a
discordar.

***

## Alarmes e lembretes

Estado do plano e as decisões completas em [`alarmes-e-lembretes.md`](alarmes-e-lembretes.md).
Resumo do que está no código:

- **`ReminderStore`** — wrapper sobre `node:sqlite`, único ponto a trocar se a API
  mudar. Migrações **só aditivas** com `PRAGMA user_version`, e `SELECT` sempre de
  colunas explícitas, nunca `SELECT *`. Motivo: o `activate.sh` faz rollback para a
  release anterior, e uma migração que a versão antiga não lê tornaria o rollback letal.
- **`ReminderScheduler`** — **um** timer auto-corretivo (`MAX_TIMER_DELAY_MS`, 60 s),
  não um `setTimeout` por alarme.
- **`AlarmRinger`** — o ciclo de toque, uma FSM por sala: rajada → janela de escuta
  → rajada, até dispensa, soneca ou o teto de `alarmMaxRingMs`. A janela existe
  porque em `RESPONDING` o firmware **desliga a wake word**: um alarme que toca
  continuamente é um alarme que não se desliga por voz.
- **`chime.ts`** — PCM do bipe, gerado uma vez no load do módulo.
- Caminho de entrega: `Orchestrator.ringBurst(roomId, force, speech)` reusa
  `speaking_start` → `audio_response` → `speaking_end` e o fan-out por sala.
  Nenhum `MessageType` novo, nenhuma mudança de firmware.

Três invariantes que não são óbvios lendo o código:

- **O `onFire` do scheduler só resolve no fim do ciclo.** É a promise dele que
  segura a vaga em `firingRooms` enquanto o alarme toca; liberando cedo, um segundo
  lembrete da mesma sala seria disparado por cima, com `markRinging` já gravado e
  `fire_count` incrementado num lembrete que nunca tocou.
- **O guard de barge-in vem de `onUserSpeech`, não do áudio recebido.** Em open-mic
  o satélite transmite continuamente, então "chegou áudio agora" seria sempre
  verdadeiro e o alarme nunca tocaria — mesma armadilha que o `TtfabTracker`
  documenta para a âncora de TTFAB.
- **O estado do ciclo não é limpo por `releaseRoom`.** Uma sala cujo provider morreu
  continua tendo alarmes.

**A fala do lembrete é pré-renderizada na criação** e guardada como BLOB em
`reminder_audio`. No disparo o servidor só enfileira bytes — o alarme funciona com o
provider fora do ar. Sem BLOB, o toque degrada para só-chime, sem erro visível.
A poda desse áudio é **explícita e por status**: o `ON DELETE CASCADE` da tabela
nunca dispara, porque lembrete não é `DELETE`ado em lugar nenhum.

**Onde o banco fica** (`resolveDbPath`), em ordem de precedência:
`LUNA_DB_PATH` explícito → `$STATE_DIRECTORY` do systemd → `./.luna-state/luna.db`.

O caminho é **absoluto** de propósito e não segue o padrão relativo do
`devicesConfigPath`: o `activate.sh` troca o symlink de `/opt/luna/current` a cada
deploy e poda releases antigas — um default relativo apontaria justamente para o
diretório que some.

***

## Métrica: TTFAB

`TtfabTracker` mede do fim da fala do usuário ao primeiro áudio de resposta.

**A âncora não é "último chunk de áudio recebido".** Em open-mic o satélite streama
continuamente, então esse marco vira sempre "agora" e o TTFAB medido cai para poucos
milissegundos enquanto o usuário espera segundos — era por isso que os logs mostravam
5–40 ms num sistema visivelmente lento.

A âncora correta é o último instante em que sabemos que o usuário **ainda estava
falando** (`markUserSpeech`, alimentado pela transcrição de entrada do provider). O
primeiro chunk de áudio serve só como âncora de fallback.

```bash
cd luna-server && npm run dev
```

Os campos relevantes no log são `ttfab` e `model_decision_ms`, ambos por `room_id`.

***

## Testes

```bash
cd luna-server && npm test
```

```bash
cd luna-server && npx tsc --noEmit
```

> **A pegadinha mais cara do repositório:** o script `test` do `package.json` lista os
> arquivos **um a um, sem glob**. Todo `*.test.ts` novo precisa ser acrescentado à mão,
> senão nunca roda — nem local, nem no CI.

Outros pontos que valem saber antes de mexer:

- **Oito arquivos de teste constroem literais de `AppConfig`.** Todo campo novo
  obrigatório em `AppConfig` quebra os oito de uma vez.
- Runner é o `node:test` nativo com `tsx`, sem framework externo.
- Ponta a ponta sem hardware: o `luna-client-test` fala o mesmo protocolo.
- A interação entre `speaking_end`, o drain do buffer de playback e as janelas de wake
  word **não é reproduzível em teste unitário** — mudanças aí exigem teste manual no
  hardware.

***

## Deploy

CI dispara em push na `main` que toque `luna-server/**`. Passo a passo, layout no
servidor e rollback em [`deploy/README.md`](../luna-server/deploy/README.md).

Dois pontos que já queimaram deploy:

- **A unit systemd não é reinstalada pelo deploy.** `activate.sh` só copia `dist/` e
  `config/`; a unit em `/etc/systemd/system/` só muda com `sudo cp` + `daemon-reload`
  manuais. O `activate.sh` hoje falha rápido com `cmp` ao detectar a divergência, mas
  o passo manual continua sendo responsabilidade de quem mexe na unit.
- **O runner não tem `setup-node`** — usa o Node da máquina. Em Node < 22.5 o import de
  `node:sqlite` morre no boot. Existe um guard de versão no workflow, antes de montar
  a release.
