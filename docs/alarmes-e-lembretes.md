# Alarmes e lembretes — plano de implementação

**Status:** Implementado — marcos 0 a 11 entregues. Falta a calibração no hardware
dos marcos 7 e 8 (`RING_LISTEN_WINDOW_MS`, `RING_MAX_DEFER_MS` — as duas são env), que não pôde ser
feita por não haver satélite disponível; os valores em uso são derivados das
constantes do firmware, com comentário datado no código dizendo isso.
**Data:** 2026-08-19 (plano) · 2026-08-24 (implementação)

> **Duas correções ao que este plano previa**, descobertas na implementação e
> registradas no [ADR 007](adr/007-audio-nao-solicitado.md):
>
> 1. **O guard de barge-in não pode vir do áudio de entrada** (`lastAudioAtByRoom`,
>    decisão 9). Em open-mic o satélite transmite continuamente, então esse marco
>    seria sempre "agora" e o alarme nunca tocaria. O sinal usado é a transcrição
>    de entrada do provider (`onUserSpeech`), com teto de adiamento.
> 2. **O watchdog de `speaking_end` não precisou mudar** (decisão 11). Ele mede
>    liveness do provider, não estado de fila; cada rajada tem duração conhecida e
>    fecha o par sincronicamente. Há teste travando esse invariante.

## Objetivo

Hoje a Luna só reage. O usuário fala, ela responde ou aciona o Home Assistant. Não existe nenhum caminho pelo qual o servidor **inicie** uma interação: todo áudio de saída nasce em `provider.onAudioResponse`, que só é alcançado a partir de `handleAudioChunk`.

Marcar alarmes e lembretes por voz é a primeira funcionalidade que exige três capacidades que o sistema não tem:

1. **Estado que sobrevive a restart.** O `luna-server` não escreve em disco — o único I/O é o `readFileSync` do `devices.json`, e o `luna-server.service` diz literalmente *"O processo nao escreve em disco: nenhum ReadWritePaths necessario"*. O CI faz deploy a cada push em `main` com restart do systemd; um alarme para as 7h não sobrevive a um deploy às 3h.
2. **Fala proativa.** A Luna não sabe falar sem ter sido perguntada.
3. **Endereçar um satélite.** `WsServer.clients` é `Map<WebSocket, ClientState>` privado, sem índice por sala. `Orchestrator.sendToClientByRoom` guarda **uma** closure por sala e só é populado depois que o satélite transmite áudio — um satélite ocioso com wake word nunca transmite nada e é inalcançável.

O resultado esperado: *"Luna, me acorda às 7"*, *"me lembra de tomar o remédio daqui a 20 minutos"* e *"todo dia útil às 6:30"* funcionam ponta a ponta, tocam no cômodo onde foram criados e são dispensáveis por voz.

## Decisões de produto

- **Escopo v1:** timer relativo, alarme absoluto único, recorrentes semanais, lembrete com mensagem falada, listar/cancelar/adiar.
- **Persistência:** SQLite no `luna-server`.
- **Onde toca:** no cômodo de origem. Satélite offline no disparo cai num cômodo de fallback vindo de config — burro de propósito, não "onde tem gente".
- **Como se dispensa:** wake word + comando de voz ("Luna, para o alarme").

## Decisões técnicas

### 1. Agendamento no servidor, não no satélite

O firmware não configura NTP nem RTC — só `millis()`/`esp_timer`, e os `ts` do envelope WS são uptime, não hora de parede. O satélite não tem como saber que horas são. Todo o agendamento é server-side; o satélite continua um alto-falante burro.

### 2. Um único relógio compartilhado, não dois

`buildLunaSystemPrompt` usa `now.getHours()` (`luna-system-prompt.ts:39`) — hora local **do processo**. A unit systemd não define `TZ=` e o CI também não: **num host UTC o prompt já hoje diz a hora errada por 3 horas.** Hoje isso só erra o "período do dia"; com alarmes, "amanhã às 7" resolveria 3h fora.

A correção é `Environment=TZ=America/Sao_Paulo` na unit **e** um helper único de "agora", compartilhado por prompt e scheduler. Corrigir só o scheduler é pior que o bug atual: o "agora" do modelo e o do servidor passariam a discordar.

`logger.ts:6-24` já fixa America/Sao_Paulo via `Intl` e documenta que o offset -03:00 é fixo desde 2019 (o Brasil aboliu o horário de verão). Reusar essa fonte, não inventar uma segunda. Sem DST, "próxima ocorrência" é aritmética sobre offset fixo — nada de motor de fuso genérico; um teste falha se um dia a zona ganhar DST.

### 3. Persistência: `node:sqlite`, não `better-sqlite3`

`node:sqlite` funciona **sem flag** no Node 22.22.2 e expõe `DatabaseSync`/`StatementSync`. Zero dependência nova, mantendo o `package.json` nas 4 deps atuais.

O `better-sqlite3` foi rejeitado porque `activate.sh` roda `npm ci --omit=dev` no runner self-hosted a cada deploy: compilaria addon nativo toda vez (python3+gcc, +30-60 s, ABI casada com o node do host).

**O risco real não é a lib, é a versão do Node do host de deploy.** O `package.json` diz `engines: node >=20.0.0` e o workflow não tem `setup-node` — usa o node da máquina. Em Node 20 o import morre no boot, o `health_ok` de `activate.sh:110` falha e o rollback dispara. Falha segura, mas deploy queimado. Portanto:

- `engines.node` sobe para `>=22.5.0`;
- passo de CI `node -e "require('node:sqlite')"` **antes** de montar a release;
- `--disable-warning=ExperimentalWarning` no `ExecStart` (o `ExperimentalWarning` vai para o journal via `StandardError=journal`);
- todo acesso passa por um wrapper (`ReminderStore`), único ponto a trocar se a API mudar.

### 4. Escrita em disco: `StateDirectory`, com migração só aditiva

`StateDirectory=luna-server` cria `/var/lib/luna-server` com dono `luna:luna` e libera escrita mesmo sob `ProtectSystem=strict` — sem `ReadWritePaths` à mão. O código lê `$STATE_DIRECTORY`, não caminho fixo.

O banco **não pode** ficar em `/opt/luna/current`: `activate.sh` troca o symlink da release a cada deploy e poda releases antigas. Por isso o caminho do DB é **absoluto** e não repete o padrão do `devicesConfigPath` (`env.ts:139`, default `'config/devices.json'`, relativo ao `WorkingDirectory`) — esse default aponta exatamente para o diretório que some. Default de dev: `./.luna-state/luna.db`.

**Migrações são o maior risco operacional desta feature — maior que a escolha da lib.** Com CI publicando a cada push e `activate.sh` fazendo rollback para a release anterior, uma migração que a versão antiga não lê torna o rollback letal: release nova migra o schema, health falha, volta o código velho, que engasga no schema novo. Portanto: `PRAGMA user_version`, migrações **só aditivas**, e `SELECT` sempre de colunas explícitas (nunca `SELECT *`).

Se o banco não abrir (permissão, corrupção), **falha no boot**. O health check pega e o rollback funciona. Um fallback silencioso para `:memory:` faria alarmes sumirem a cada restart sem nenhum sinal.

### 5. Um único timer auto-corretivo, não um `setTimeout` por alarme

O scheduler mantém **um** `setTimeout`, clampado em **~60 s**, re-derivando `delay = due - now()` a cada acordada. Não é polling burro: é um timer só, auto-corretivo. Clampar em 60 s (em vez de perto do teto de ~24,8 dias do `setTimeout`) resolve de uma vez o teto, o drift do relógio e o salto de NTP ou suspensão de VM, que o `setTimeout` não acompanha.

- `.unref()` obrigatório, mesmo padrão de `deviceRegistrySource.ts:156` — sem ele, `node --test` não sai.
- `stop()` no shutdown de `index.ts:88-108`, ao lado de `deviceRegistry.stop()`.
- **Catch-up precisa de política, não só mecanismo.** Um deploy às 3h depois de 3h fora não pode disparar o alarme das 6:30 às 9:30, nem despejar um dia de alarmes de uma vez. Dispara se `now - due <= MISSED_GRACE_MS` (15 min); mais velho vira `missed`. Recorrente com catch-up colapsado a **no máximo uma** ocorrência.
- **Idempotência a crash:** `status='ringing'` e o avanço de `next_due_utc` são gravados na mesma transação, *antes* de o áudio sair. Sem isso, um crash no meio do toque re-dispara o one-shot a cada boot. No boot, `ringing` mais velho que `ALARM_MAX_RING_MS` vira `done`.
- Fila por sala (o ciclo de toque é uma FSM por sala) e teto global: 20 alarmes simultâneos não podem abrir 20 sessões de provider.

`nowFn` injetável, como `sleepImpl` em `HomeAssistantClient` e `providerFactory` em `RoomManager`, para testar com `mock.timers` sem wall-clock.

### 6. O servidor resolve data e hora; o modelo nunca manda timestamp

`buildLunaSystemPrompt` congela a hora no `connect` — numa sessão longa o relógio do modelo envelhece. Aceitar um ISO datetime gerado pelo LLM daria alarme na data errada, em silêncio: a mesma classe de bug que o [ADR 002](adr/002-function-calling-contract.md) já documenta para o `room_id` alucinado.

A tool aceita só **intenção**, nunca instante absoluto: `in_seconds` (relativo) ou `at_time` (`"HH:MM"` local) + `day_offset`/`repeat`. O servidor converte com o próprio relógio. Mesma regra do `room_id`: quem tem certeza decide.

O resultado da tool devolve a data resolvida **em texto** (`"amanhã às 07:00"`), e o prompt manda a Luna confirmar usando esse texto — a confirmação falada nunca diverge do que foi agendado.

### 7. Recorrência por `enum`, não por CSV

`providers/gemini/tool-mapping.ts` só propaga `type`, `description` e `enum` por propriedade — sem `items`, sem objetos aninhados, e `toSchemaType` **lança** em tipo desconhecido. Um array de dias da semana quebra o adapter do Gemini.

A primeira ideia foi uma string CSV (`"mon,tue,wed"`), mas ela tem dois defeitos: não é validável pelo lado do Gemini, e **não distingue "sexta às 20h" (uma vez) de "toda sexta às 20h"**. Um assistente em PT-BR ainda emitiria `"seg,ter"` de vez em quando.

A solução é um `enum`, que o `tool-mapping.ts` propaga de verdade:

```
repeat: enum ['none','daily','weekdays','weekend','mon','tue','wed','thu','fri','sat','sun']
```

Com `repeat: 'none'` + `weekday` separado, "sexta às 20h" vira one-shot na próxima sexta. Conjuntos arbitrários ("segunda e quinta") ficam fora da v1 — viram dois lembretes.

### 8. Entrega reusando `speaking_start` → `audio_response` → `speaking_end`

**Nenhum tipo novo no protocolo WS, nenhuma mudança de firmware.** O envelope tem **quatro** cópias (`luna-server/src/ws/protocol.ts`, `luna-firmware/src/ws/LunaWsClient.cpp`, `luna-desktop/src/main/ws/protocol.ts`, `luna-client-test/src/protocol.ts`), e firmware e desktop degradam para "ignora em silêncio" — um tipo novo mal espelhado é regressão invisível.

O caminho existente já faz o necessário: `onSpeakingStart()` entra em `RESPONDING` de qualquer estado, suspende o TX (AEC), e o retorno a `IDLE` só acontece quando o `playbackBuffer` esvazia.

O chime **tem** que passar por `enqueueAudioFrames`: 1 s de tom são 32 000 bytes, e o ESP32 fecha a conexão ao receber frame binário grande (`Orchestrator.ts:31-34`). O gerador em TypeScript replica as duas propriedades de `AudioPlayback::renderTone` (`AudioPlayback.cpp:88-108`): **amplitude 8000**, não fundo de escala (full-scale sai duro no MAX98357A), e rampa linear de ~5 ms nas duas pontas, senão dá clique. Gerado uma vez no load do módulo, não por disparo.

**Pular o `speaking_start` seria um bug:** `handleBinaryFrame` não checa estado, então o áudio tocaria com a FSM em `IDLE_LISTENING`, onde `shouldDetectWake()` é verdadeiro — o próprio chime alimentaria o detector. No `luna-desktop` o motivo é outro: ele tolera `audio_response` sem `speaking_start` (`session.ts:137-146`), mas seu watchdog de 5 s chama `flushPlayback` e **cortaria a cauda** do alarme.

Dois preços de não mexer no firmware: **não há sinal visual** (IDLE e RESPONDING compartilham LED apagado, `StateMachine.cpp:32-34`), e cada rajada paga o drain do playback.

### 9. Alarme não pode truncar uma fala em andamento

`onSpeakingStart()` entra em RESPONDING **de qualquer estado**, e `main.cpp:51-58` faz `xQueueReset(txQueue)`. Se o alarme dispara com o satélite em `ACTIVE_STREAMING`, a frase do usuário é cortada e o provider recebe meio comando.

Guard server-side: não iniciar rajada se chegou áudio daquela sala nos últimos N segundos. **Esse campo não existe hoje** — é preciso adicionar `lastAudioAtByRoom` no Orchestrator. O mesmo campo resolve a corrida da borda da rajada (ver decisão 11), o que faz do barge-in **pré-condição** do ciclo de toque, não um marco posterior.

### 10. Áudio do lembrete pré-renderizado; `speak()` ao vivo é fallback

Para a Luna dizer *"são sete horas, hora de tomar o remédio"* na própria voz, o áudio tem que sair do provider. Mas sintetizar **no instante do disparo** põe no caminho crítico até 5 s de `providerConnectTimeoutMs` mais o round-trip do modelo — e o Gemini derruba sessão ociosa (`ACTIVE_CONVERSATION_WINDOW_MS = 60_000`), então um alarme às 7h sempre pagaria um `connect`.

Pior: o alarme dependeria do provider estar no ar exatamente quando o usuário menos perdoa falha.

Então o PCM16 do lembrete é **pré-renderizado** — na criação, ou T-60 s antes do vencimento — e guardado como BLOB. No disparo o servidor só enfileira bytes. Pontualidade determinística, funciona com o Gemini fora do ar ou em rate limit, e disparar nunca precisa de sessão viva.

O port ganha `speak()` mesmo assim, como fallback e para a pré-renderização:

```typescript
/** Faz a IA produzir uma fala a partir de uma instrução textual, sem áudio de entrada. Resolve false se a sessão não estava viva. */
speak(instruction: string): Promise<boolean>;
```

Retorna `boolean` porque hoje **nenhum dos dois adapters expõe "a sessão está viva"**: `speak()` numa sessão morta seria no-op silencioso (`this.session` no Gemini, `this.connected` no OpenAI), e o caminho do alarme precisa saber que falhou para cair no toque só-chime.

- **Gemini:** `session.sendClientContent({ turns, turnComplete: true })`. Duas ressalvas: injeta um turno de **usuário**, então o modelo parafraseia em vez de ler literal; e a resposta volta por `handleMessage` → `onTurnComplete` → `appendTurn` com `userText` vazio, sujando o ring buffer. A assinatura exata deve ser conferida contra o `@google/genai` instalado.
- **OpenAI:** `response.create` com `response: { instructions, conversation: 'none' }` — out-of-band, não polui a conversa. **Atenção:** `sendToolResult` condiciona o `response.create` a `pendingToolCalls.size === 0` (`OpenAIRealtimeAdapter.ts:230`), justamente para duas tools no mesmo turno não gerarem falas sobrepostas. Um `speak()` incondicional reintroduz esse bug; tem que compartilhar o mesmo gate.

Se o `speak()` ao vivo for usado, toca o chime **primeiro** e fala depois — o connect acontece depois do horário devido.

### 11. Toque em rajadas com janela de escuta

Consequência direta de dispensar por wake word: em `RESPONDING` a wake word está **desligada**. Um alarme que toca continuamente é um alarme que não se desliga por voz.

Orçamento real de cada janela, lido do firmware: `speaking_end` → espera `playbackBuffer` vazio (`main.cpp:303`) → `AEC_RESUME_DELAY_MS` 150 ms → IDLE → `wakeTask` faz `xStreamBufferReset` + `WakeWord::rearm()` → `WAKE_SETTLE_WINDOWS` = 15 janelas ≈ **450 ms de supressão**. São ~600 ms surdos antes de a pessoa poder começar; "Hey Luna" leva ~700-900 ms e só conclui depois da frase. Primeiro áudio possível no servidor: **~1,4-1,6 s** dentro da janela.

| Fase | Duração | Estado do firmware | Wake word |
|---|---|---|---|
| Rajada (`speaking_start` → chime [+ fala] → `speaking_end`) | 3–4 s | `RESPONDING` | off |
| Janela de escuta | `RING_LISTEN_WINDOW_MS` (**6 s**) | `IDLE_LISTENING` | **on** |

6 s, não 4: com 4 s sobrariam ~2,4 s de folga e só funcionaria se a pessoa começasse imediatamente. Calibrar no hardware, como os `WAKE_LISTEN_*` foram.

A **primeira rajada** leva chime + fala; as seguintes só o chime, com a fala repetida a cada 4 rajadas. Repetir a frase inteira a cada 10 segundos é hostil.

Três armadilhas:

- **O watchdog de 8 s vai atrapalhar.** `SPEAKING_WATCHDOG_MS` é armado em `startSpeaking` e rearmado só em `onAudioResponse`. Uma rajada sem áudio de provider dispara um `speaking_end` espúrio. Ou rearmar por frame de alarme enfileirado, ou tornar o watchdog ciente do alarme.
- **Corrida na borda:** se a wake word do usuário cai no instante em que o servidor re-dispara a rajada, `onSpeakingStart` reseta o `txQueue` e engole a dispensa. Guard: antes de cada rajada, checar `lastAudioAtByRoom` (decisão 9).
- **Barge-in bem-sucedido custa caro:** uma vez acordado, `WAKE_LISTEN_SILENCE_MS` (5000) mantém `ACTIVE_STREAMING` aberto por até 5 s de silêncio, durante os quais não se pode tocar. Orçar isso no `ALARM_MAX_RING_MS`.

**Limitação aceita de UX:** a reação humana é falar *enquanto* toca. Durante a rajada o satélite é surdo, então a primeira tentativa se perde e o usuário aprende a esperar a pausa. Isso argumenta por um dispensar físico como escape hatch — o GPIO2 já está reservado para o botão no `config.h` —, mas fica fora da v1.

Eco do chime na wake word é risco **baixo**: um tom puro de 1200 Hz não parece fala para o modelo, e `WAKE_SETTLE_WINDOWS` existe para o caso "modelo ainda quente". O risco real é a **fala** do lembrete conter "Luna" e re-disparar a cauda — proibido no prompt e higienizado no servidor.

### 12. Fan-out por sala substitui o "último que falou"

`clientsByRoom: Map<string, Set<WebSocket>>` no `WsServer`, populado no `auth` e limpo no `close`, com `sendToRoom(roomId, data): boolean`.

**`sendToClientByRoom` é removido inteiro**, não deixado ao lado. Manter os dois criaria dois caminhos de envio por sala, e o áudio do alarme poderia se intercalar com frames de provider ainda pendentes de pacing — exatamente a corrida que o comentário de `Orchestrator.ts:64-70` existe para prevenir. `drainAudioQueue` e `command_result` passam a rotear por `sendToRoom`, o que também deixa remover o parâmetro `sendToClient` de `handleAudioChunk`.

Detalhes que não são opcionais:

- **Chavear o Set por `WebSocket`, não por `ClientState`.** O re-auth no mesmo socket substitui o objeto de estado (`WsServer.ts:332`) sem remover o antigo — vazaria entrada no índice. E o socket precisa sair da sala antiga antes de entrar na nova.
- `stop()` (`WsServer.ts:192-195`) e `handleDisconnect` (`:364`) limpam o índice.
- Guard de `readyState === OPEN`: um `sendToRoom` que varre N clientes faria buffering em socket morto-mas-não-ceifado (o reaper leva até 25 s).

Isso corrige um bug real de hoje — **com dois satélites no mesmo cômodo, a resposta vai só para o último que falou** — mas é **mudança de semântica**: um desktop e um satélite na mesma sala passam a tocar toda resposta, não só o último que falou. É o que "sala" significa, e é o que o alarme precisa, mas mexe nas expectativas de `WsServer.integration.test.ts`.

### 13. O bind dos callbacks migra para a criação da sala

`bindProviderCallbacksOnce` só roda no primeiro `handleAudioChunk` (`Orchestrator.ts:106`). Um provider criado pelo caminho do alarme — para pré-renderizar ou falar — **não teria `onAudioResponse` registrado**: a fala do lembrete seria gerada e cairia no vazio, sem erro nenhum.

O bind migra para `RoomManager.createProviderSession`. Sem isso, a decisão 10 não funciona.

### 14. Dispatch de tools por handler, com contexto explícito

O bloqueio não é o `if (!isControlDeviceCall)` de `Orchestrator.ts:284`. É que **todo o handler vive dentro do closure `bindProviderCallbacksOnce`**, com acesso a `sendToClient`, `startSpeaking` e `endSpeaking`. Um `Map<string, ToolHandler>` fora do closure perderia esse acesso; dentro, seria reconstruído por provider.

A forma certa é um `ToolContext { roomId, deviceId, provider, callId }` explícito, com o handler devolvendo um resultado que o closure despacha — senão o andaime de log e o `.catch` de `Orchestrator.ts:396-426` são duplicados em cada tool.

O handler de `set_reminder` faz `INSERT` síncrono, e `DatabaseSync` bloqueia o event loop que também roda o tick de 32 ms de `drainAudioQueue`. Um fsync lento vira buraco audível na resposta de **outro** cômodo — daí WAL + `synchronous=NORMAL` e escritas minúsculas.

### 15. Vocabulário de tools enxuto, por causa do TTFAB

`RoomManager.ts:55` declara hoje **uma** tool. A v1 pediria cinco (`set`, `list`, `cancel`, `snooze`, `dismiss`). Cada schema entra no orçamento de instrução da sessão Live e sobe o `model_decision_ms` — e com `geminiThinkingBudget: 0` (`env.ts:154`) o modelo não tem folga para deliberar. Mais tools também sobem o falso-positivo em conversa fiada ("me lembra daquele filme" → `set_reminder`).

Por isso o gerenciamento é colapsado em **duas** tools: `set_reminder` e `manage_reminders(action: enum)`. A série `ttfab`/`model_decision_ms` que `Orchestrator.ts:220-230` já loga de graça deve ser medida antes e depois.

### 16. Estado de alarme sobrevive a `releaseRoom`

Os 7 mapas por sala do Orchestrator são todos limpos por `releaseRoom` (`:475-501`). O estado do alarme é diferente: uma sala cujo provider morreu **continua tendo alarmes**. `onSessionEnded` → `releaseRoom` → `evictRoom` apagaria os timers de toque no meio do toque.

Estado de alarme vive em objeto separado, com ciclo próprio. Se a sala esvazia durante o toque, o ciclo para e o registro volta a `armed` no banco — a próxima janela de disparo pega o satélite de volta.

## Contrato das tools

Duas tools, seguindo o molde de `CONTROL_DEVICE_TOOL` em `providers/types.ts`: uma constante `ToolDefinition` mais um type guard exportado no mesmo módulo, como manda o [ADR 002](adr/002-function-calling-contract.md). Todo schema é **plano** — sem array, sem objeto aninhado (decisão 7).

### `set_reminder`

| Campo | Tipo | Descrição |
|---|---|---|
| `label` | string | O que lembrar ("tomar o remédio"). Ausente = alarme sem mensagem |
| `in_seconds` | number | Para "daqui a X". Exclusivo com `at_time` |
| `at_time` | string | `"HH:MM"` 24h, relógio local. Exclusivo com `in_seconds` |
| `when_day` | enum | `today`, `tomorrow`, `mon`…`sun`. Ausente = próxima ocorrência de `at_time` |
| `repeat` | enum | `none` (default), `daily`, `weekdays`, `weekend`, `weekly` |

`when_day` e `repeat` são ortogonais, e é isso que desambigua os casos que um CSV de dias não separa:

| Fala | `at_time` | `when_day` | `repeat` |
|---|---|---|---|
| "daqui a 10 minutos" | — (`in_seconds=600`) | — | — |
| "me acorda às 7" | `07:00` | — | `none` |
| "amanhã às 6:30" | `06:30` | `tomorrow` | `none` |
| "sexta às 20h" | `20:00` | `fri` | `none` |
| "toda sexta às 20h" | `20:00` | `fri` | `weekly` |
| "todo dia útil às 6:30" | `06:30` | — | `weekdays` |
| "todo dia às 7" | `07:00` | — | `daily` |

O guard é tão paranoico quanto `isControlDeviceCall` (`types.ts:80-94`) — args são texto gerado por modelo, fronteira de confiança:

- **exatamente um** de `in_seconds`/`at_time`; a combinação é rejeitada, não resolvida em silêncio;
- `in_seconds` clampado em `[10, 2592000]` (30 dias) — um `999999999` alucinado criaria alarme no ano 33000;
- `at_time` contra `/^([01]\d|2[0-3]):[0-5]\d$/`;
- `repeat: 'weekly'` exige `when_day` sendo dia da semana;
- `label` com limite de tamanho e higienizado (é texto que vai ser falado), rejeitando a wake word "luna" (decisão 11);
- **teto de lembretes por sala** — um loop de tool calls inseriria milhares de linhas.

O `room_id` continua descartado em favor do da sessão, pela política do ADR 002. O modelo não escolhe onde toca.

**Ambiguidade que o schema não resolve:** "às sete" à noite é 19h em português. Isso é trabalho do modelo, e a `description` do campo precisa dizer isso explicitamente.

Retorno: `{ success, reminder_id, spoken_when: "amanhã às 07:00", label }`, ou `{ success: false, error }` com mensagem escrita para ser falada — mesmo padrão que `control_device` usa para dispositivo não encontrado.

### `manage_reminders`

| Campo | Tipo | Descrição |
|---|---|---|
| `action` | enum | `list`, `cancel`, `snooze`, `dismiss` |
| `reminder_id` | string | Id curto vindo do `list` |
| `at_time` | string | "cancela o das 7" |
| `label` | string | "cancela o do remédio" |
| `minutes` | number | Só para `snooze` (`1..60`) |

`dismiss` e `snooze` agem sobre o alarme que está tocando **naquela sala** — o modelo não precisa saber o id, e viram no-op quando nada toca. Isso evita ter de injetar uma nota na sessão quando o toque começa (o system prompt foi congelado no `connect`, antes de o alarme existir).

`cancel` com mais de um candidato devolve `{ success: false, error }` pedindo desambiguação — falada, não erro técnico.

Num recorrente, `dismiss` encerra só o toque atual; a próxima ocorrência é recomputada normalmente.

**Fallback obrigatório:** se o modelo não chamar a tool, qualquer conversa na sala durante o toque dispensa o alarme ao fim do turno. Ter falado com a Luna já prova que a pessoa acordou.

## Esquema do banco

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA temp_store   = MEMORY;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id      TEXT    NOT NULL,          -- 4 chars, para referência por voz
  room_id       TEXT    NOT NULL,          -- sala de origem = onde toca
  label         TEXT,                      -- texto falado; NULL = só alarme
  kind          TEXT    NOT NULL CHECK (kind IN ('once','recurring')),

  -- one-shot: instante absoluto, epoch ms UTC, já resolvido pelo servidor
  due_at_utc    INTEGER,

  -- recorrente: hora local (America/Sao_Paulo) + regra
  local_hour    INTEGER CHECK (local_hour   BETWEEN 0 AND 23),
  local_minute  INTEGER CHECK (local_minute BETWEEN 0 AND 59),
  repeat_rule   TEXT CHECK (repeat_rule IN
                  ('daily','weekdays','weekend','mon','tue','wed','thu','fri','sat','sun')),

  -- materializado: o que o scheduler lê. Sempre epoch ms UTC.
  next_due_utc  INTEGER NOT NULL,

  status        TEXT    NOT NULL DEFAULT 'armed'
                  CHECK (status IN ('armed','ringing','done','cancelled','missed')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_fired_at INTEGER,
  fire_count    INTEGER NOT NULL DEFAULT 0,

  CHECK ((kind = 'once'      AND due_at_utc IS NOT NULL AND repeat_rule IS NULL)
      OR (kind = 'recurring' AND repeat_rule IS NOT NULL AND local_hour IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders (next_due_utc) WHERE status IN ('armed','ringing');
CREATE INDEX IF NOT EXISTS idx_reminders_room
  ON reminders (room_id, status);

-- Só com a pré-renderização da decisão 10.
CREATE TABLE IF NOT EXISTS reminder_audio (
  reminder_id INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
  pcm16_16k   BLOB    NOT NULL,
  rendered_at INTEGER NOT NULL
);
```

O `repeat_rule` do banco é a regra **já resolvida**, não o campo da tool: `repeat: 'weekly'` + `when_day: 'fri'` é persistido como `repeat_rule = 'fri'`, e `repeat: 'none'` grava `kind = 'once'` com `due_at_utc`. A tradução vive no `ReminderStore`, num ponto só.

O que cada escolha compra:

- **`next_due_utc` materializado** reduz o scheduler a `SELECT … ORDER BY next_due_utc LIMIT 1`. Sem ele, o timer único teria de recomputar recorrência em memória a cada mutação.
- **`status='ringing'` persistido** torna um crash no meio do toque recuperável: no boot, `ringing` mais velho que `ALARM_MAX_RING_MS` vira `done`.
- **`fire_count`** é a métrica barata de "o alarme realmente tocou".
- **Sem tabela de snooze:** snooze é `UPDATE next_due_utc`, preservando o invariante "uma linha = um lembrete visível ao usuário" de que o `list` depende.
- 15 s de fala ≈ 480 KB em `reminder_audio` — precisa de teto e poda.

Versionamento por `PRAGMA user_version`, migrações só aditivas, `SELECT` de colunas explícitas (decisão 4).

## Estrutura do projeto

```
luna-server/src/
  time/clock.ts               # helper único de "agora" em America/Sao_Paulo (prompt + scheduler)
  reminders/
    ReminderStore.ts          # wrapper node:sqlite — CRUD + migrações (único ponto de SQL)
    ReminderScheduler.ts      # timer único auto-corretivo, rehydrate, catch-up, nowFn injetável
    recurrence.ts             # when_day/repeat → próxima ocorrência
    tools.ts                  # ToolDefinition + type guards das 2 tools
    AlarmRinger.ts            # FSM de toque por sala: rajada/janela, barge-in, snooze
    chime.ts                  # gerador de PCM16 (seno, amplitude 8000, rampa de 5ms)
  orchestrator/Orchestrator.ts  # dispatch com ToolContext; lastAudioAtByRoom; deliverAlarm()
  ws/WsServer.ts                # clientsByRoom (chaveado por ws) + sendToRoom
  providers/IAudioProvider.ts   # + speak(instruction): Promise<boolean>
  providers/{gemini,openai}/*Adapter.ts
  rooms/RoomManager.ts          # bind dos callbacks migra para cá; tools: [...]
  prompts/luna-system-prompt.ts # seção "# Alarmes e lembretes"
  config/env.ts                 # LUNA_DB_PATH, ALARM_*, RING_*
luna-server/deploy/luna-server.service   # StateDirectory, TZ, --disable-warning
.github/workflows/deploy.yml             # guard de versão de Node
docs/adr/005-persistencia-no-servidor.md
docs/adr/006-agendamento-e-contrato-de-tempo.md
docs/adr/007-audio-nao-solicitado.md
```

## Features, em ordem de desenvolvimento

O que o usuário ganha, e em qual marco. Os marcos 0–5 não entregam nada visível: são as capacidades que faltam no sistema.

| # | Feature | Exemplo de fala | Marco |
|---|---|---|---|
| — | *(infra)* Relógio único e correto | — | 0 |
| — | *(infra)* Endereçar satélite por sala | — | 1 |
| — | *(infra)* Dispatch de várias tools | — | 2 |
| — | *(infra)* Estado que sobrevive a restart | — | 3 |
| — | *(infra)* Acordar na hora, inclusive após deploy | — | 4 |
| — | *(infra)* Tocar um som num satélite | — | 5 |
| 1 | **Timer relativo** | "me avisa daqui a 10 minutos" | 6 |
| 2 | **Alarme absoluto único** | "me acorda às 7" / "amanhã às 6:30" | 6 |
| 3 | **Dispensar e adiar** | "Luna, para o alarme" / "soneca de 5 minutos" | 7 |
| 4 | **Lembrete com mensagem falada** | "me lembra de tomar o remédio às 20h" | 8 |
| 5 | **Recorrentes** | "todo dia útil às 6:30" / "toda sexta às 20h" | 9 |
| 6 | **Listar e cancelar** | "quais alarmes eu tenho?" / "cancela o das 7" | 10 |

Duas ordens aqui são obrigatórias, não preferência:

- **Dispensar (3) vem antes de falar (4).** Um alarme que toca e não desliga é pior que nenhum alarme, e o guard de `lastAudioAtByRoom` que o barge-in exige é o mesmo que impede o alarme de truncar a fala do usuário (decisão 9). Barge-in é pré-condição do toque, não polimento posterior.
- **A fala (4) vem depois de o toque só-chime funcionar.** Assim o alarme é confiável sem depender de provider no ar, e a pré-renderização entra sem estar no caminho crítico de nada.

Depois do marco 8, as features 5 e 6 são independentes e podem ser trocadas de ordem.

## Ordem de construção

Cada marco é verificável isoladamente.

0. **Relógio único.** `TZ` na unit, `time/clock.ts`, prompt e scheduler na mesma fonte. *Verifica:* teste de prompt com hora injetada. Minúsculo, e corrige um bug que já existe hoje.

1. **Endereçamento por sala.** `clientsByRoom` chaveado por `ws`, `sendToRoom`, **remoção** de `sendToClientByRoom`, `drainAudioQueue` e `command_result` roteados pelo novo caminho. *Verifica:* dois clientes WS na mesma sala recebem ambos `speaking_start` e o áudio — é o bug dos dois satélites, corrigido e testado, sem feature nova. TTFAB reconferido.

2. **Registry de dispatch.** `ToolContext`, `control_device` extraído para handler, bind migrado para `RoomManager.createProviderSession`. Nenhuma tool nova. *Verifica:* testes de integração atuais passam + teste de nome desconhecido devolvendo "argumentos inválidos".

3. **`ReminderStore`.** `node:sqlite`, `user_version`, `StateDirectory`, fail-fast na abertura, `engines >= 22.5.0`, guard de Node no CI. *Verifica:* unit com `:memory:` + teste de boot e reabertura do arquivo.

4. **`ReminderScheduler`.** Timer único auto-corretivo (clamp 60 s), rehydrate, política de catch-up, idempotência a crash, `unref()` + `stop()` no shutdown. *Verifica:* relógio injetado e sink falso de disparo; casos de vencido-no-boot e carência estourada. Zero áudio.

5. **Chime.** `ringOnce(roomId)` manda o PCM pela fila existente. *Verifica:* frames ≤ 1024 B e par `speaking_start`/`speaking_end` bem formado.

6. **`set_reminder` (relativo + absoluto one-shot).** Primeiro marco demoável: tool → store → scheduler → chime. Inclui fallback de sala offline. *Verifica:* ponta a ponta com `luna-client-test`; manual no satélite real.

7. **Ciclo de toque, dispensa e soneca.** `AlarmRinger`, `manage_reminders`, `lastAudioAtByRoom`, barge-in, `ALARM_MAX_RING_MS`, watchdog ciente do alarme. *Verifica:* manual no hardware — mede-se a janela real de escuta e calibra-se `RING_LISTEN_WINDOW_MS`.

8. **Fala do lembrete.** `speak()` no port e nos dois adapters, pré-renderização em `reminder_audio`, degradação para chime-só. *Verifica:* `FakeAudioProvider` cobre `speak`; paridade Gemini/OpenAI; manual com os dois providers.

9. **Recorrentes.** `recurrence.ts`, `repeat`/`when_day`, recomputo após cada disparo. *Verifica:* testes de tabela da próxima ocorrência, incluindo virada de semana; um teste falha se a zona ganhar DST.

10. **Listar e cancelar.** `manage_reminders` completo, `short_id`, desambiguação falada. *Verifica:* manual — criar três, listar, cancelar por horário e por label.

11. **Seção de prompt e few-shots.** Por último, de propósito: o modelo não deve receber tools que ainda não funcionam.

## Verificação

```bash
cd luna-server && npm test
cd luna-server && npx tsc --noEmit
```

**A pegadinha mais cara do repo:** o script `test` do `package.json` lista os arquivos **um a um, sem glob**. São ~7 arquivos de teste novos aqui (`clock`, `ReminderStore`, `ReminderScheduler`, `recurrence`, `tools`, `AlarmRinger`, `chime`); esquecer um significa teste que nunca roda, nem local nem no CI. É a regressão silenciosa mais provável desta feature.

Outros pontos:

- **Oito** arquivos de teste constroem literais de `AppConfig` (`deviceRegistrySource`, `HomeAssistantClient`, `Orchestrator.integration`, `GeminiLiveAdapter`, `AudioProviderFactory`, `RoomManager`, `WsServer.hardening`, `health`). Cada campo novo obrigatório quebra os oito.
- `WsServer.integration.test.ts` e `hardening.test.ts` assumem um cliente por sala e `sendToClient` por conexão — o fan-out do marco 1 mexe nos dois.
- `luna-system-prompt.test.ts` tem 17 blocos `it(`, mas só três tocam a linha de hora. Acrescentar uma seção não quebra quase nada; adicionar um teste da seção nova no mesmo estilo.
- **TTFAB** tem dois vetores de regressão: schemas de tool a mais inflando o `model_decision_ms` com `thinkingBudget: 0`, e stall do event loop por escrita SQLite síncrona durante o tick de 32 ms de `drainAudioQueue`, que vira buraco audível. Medir a série `ttfab` no mesmo modelo antes e depois.
- Ponta a ponta sem hardware: `luna-client-test` fala o mesmo protocolo e aceita frames de qualquer tamanho.
- **Manual no hardware é obrigatório nos marcos 6, 7 e 8.** A interação entre `speaking_end`, o drain do `playbackBuffer`, o `WAKE_SETTLE_WINDOWS` e a janela de escuta não é reproduzível em teste unitário.
- **Revisão:** o `CLAUDE.md` manda despachar o agente `luna-code-reviewer` em toda mudança de código.

## ADRs previstos

- **005 — Persistência no `luna-server`** (marco 3). Reverte uma propriedade declarada do sistema e cria invariante nova de deploy (StateDirectory, migração vs. rollback). `node:sqlite` vs `better-sqlite3` é seção de alternativas dentro dele, não ADR própria.
- **006 — Agendamento server-side e contrato de tempo** (marco 4). Por que sem NTP/RTC no satélite, timer único auto-corretivo, política de catch-up, relógio São Paulo único.
- **007 — Áudio não solicitado e endereçamento por sala** (marco 7). Reuso de `speaking_start`, o trade-off rajada/janela com os números de `WAKE_SETTLE_WINDOWS` e `AEC_RESUME_DELAY_MS`, e por que o fan-out substituiu o "último que falou". Emenda os ADRs 001/002 em vez de substituí-los.

Não viram ADR: o formato do schema das tools (é consequência da limitação já documentada em `tool-mapping.ts:27-46` — vale uma nota em "Consequências" do ADR 002), a frequência e a rampa do chime (comentário de código), e os timings de rajada (serão calibrados no hardware como os `WAKE_LISTEN_*`, com a mesma disciplina de comentário datado do `config.h`).

`docs/PROJETO LUNA.md` §4 só muda se um `MessageType` novo for adicionado — e a v1 deliberadamente não adiciona nenhum.

## Fora de escopo para v1

- **Conjuntos arbitrários de dias** ("segunda e quinta"), **data absoluta** ("dia 12 às 9"), mensal, anual e intervalos ("a cada 2 horas").
- **Editar** um lembrete existente ("muda o alarme das 7"). Só criar, cancelar e adiar — editar exige resolver identidade por voz, problema de desambiguação bem mais duro do que parece.
- **Escolher o cômodo por voz** ("alarme no quarto"), toque na casa inteira, follow-me. O fallback de origem-offline é v1, mas burro: um cômodo de fallback vindo de config.
- **Dispensar por botão físico** (GPIO2 já reservado no `config.h`). É o escape hatch natural para a limitação de UX da decisão 11, mas exige mexer no firmware.
- **Sinal visual de alarme tocando.** IDLE e RESPONDING compartilham LED apagado; um estado novo é mudança de firmware.
- **Fuso configurável.** São Paulo fixo, como o `logger.ts` faz.
- **Rampa de volume, alarme escalonado, som customizável, música.**
- **Qualquer UI** de gerenciamento. O `luna-desktop` compartilha o protocolo — ele vai tocar, e isso basta.
- **Migrar o `ConversationRingBuffer` para o banco** "já que agora tem banco". Resistir: ciclo de vida e história de privacidade diferentes, precisaria de ADR próprio.
- **Multiusuário** — nada identifica quem pediu o lembrete.
- **Lembrete que aciona o HA** ("às 7 acende a luz"). Isso é automação e pertence ao Home Assistant, não ao scheduler da Luna. Vale declarar explicitamente porque o modelo **vai** tentar combinar `set_reminder` com `control_device`.
