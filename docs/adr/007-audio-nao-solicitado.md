# ADR 007 — Áudio não solicitado e endereçamento por sala

**Status:** Aceito
**Data:** 2026-08-24
**Contexto:** Marcos 1, 7 e 8 de alarmes e lembretes ([docs/alarmes-e-lembretes.md](../alarmes-e-lembretes.md))

Este ADR **emenda** os [001](001-audio-provider-abstraction.md) e
[002](002-function-calling-contract.md); não substitui nenhum dos dois.

## Contexto

Até aqui a Luna só reagia. Todo áudio de saída nascia em `provider.onAudioResponse`,
que só era alcançado a partir de `handleAudioChunk` — ou seja, de alguém ter falado.
Um alarme exige o contrário: o servidor **inicia** a interação.

Três obstáculos, nenhum deles óbvio:

1. **Não havia como endereçar um satélite.** `WsServer.clients` era
   `Map<WebSocket, ClientState>`, sem índice por sala, e `sendToClientByRoom`
   guardava **uma** closure por sala, populada só depois que o satélite
   transmitisse áudio. Um satélite ocioso — que só acorda por wake word e nunca
   transmite — era **inalcançável**.
2. **Um alarme que toca é um alarme surdo.** Em `RESPONDING` o firmware desliga a
   wake word (`shouldDetectWake()` exige `IDLE_LISTENING`), justamente para a Luna
   dizendo "Luna" não se reacordar. Tocar continuamente seria um alarme que não se
   desliga por voz.
3. **Falar exige um provider vivo** exatamente quando o usuário menos perdoa falha.

## Decisão

### 1. Nenhum tipo novo no protocolo WebSocket

O toque reusa `speaking_start` → `audio_response` → `speaking_end`.

O envelope tem **quatro** cópias (`luna-server`, `luna-firmware`, `luna-desktop`,
`luna-client-test`) e não há gerador nem teste cruzado; firmware e desktop degradam
para "ignora em silêncio". Um tipo novo mal espelhado é regressão invisível.

O caminho existente já faz o necessário: `onSpeakingStart()` entra em `RESPONDING`
de qualquer estado, suspende o TX (AEC) e só volta a `IDLE` quando o
`playbackBuffer` esvazia.

**Pular o `speaking_start` seria um bug:** `handleBinaryFrame` não checa estado, então
o áudio tocaria com a FSM em `IDLE_LISTENING`, onde `shouldDetectWake()` é
verdadeiro — o próprio chime alimentaria o detector.

Dois preços aceitos: **não há sinal visual** (IDLE e RESPONDING compartilham LED
apagado) e cada rajada paga o drain do playback.

### 2. Fan-out por sala substitui o "último que falou"

`clientsByRoom: Map<string, Set<WebSocket>>`, populado no `auth` e limpo no `close`,
com `sendToRoom(roomId, data): number`.

`sendToClientByRoom` foi **removido inteiro**, não deixado ao lado: dois caminhos de
envio por sala fariam o áudio do alarme se intercalar com frames de provider ainda
pendentes de pacing.

Isso corrige um bug real que existia — **com dois satélites no mesmo cômodo, a
resposta ia só para o último que falou** —, mas é mudança de semântica: um desktop e
um satélite na mesma sala passam a tocar toda resposta. É o que "sala" significa.

### 3. Toque em rajadas, com janela de escuta

Consequência direta de dispensar por wake word:

| Fase | Duração | Estado do firmware | Wake word |
|---|---|---|---|
| Rajada (`speaking_start` → chime [+ fala] → `speaking_end`) | ~1 s + fala | `RESPONDING` | off |
| Janela de escuta | `RING_LISTEN_WINDOW_MS` (**6 s**) | `IDLE_LISTENING` | **on** |

O orçamento de dentro da janela, lido do firmware: drain do `playbackBuffer` +
`AEC_RESUME_DELAY_MS` (150 ms) + rearme da wake word com `WAKE_SETTLE_WINDOWS` (15
janelas ≈ 450 ms) ≈ **600 ms surdos**; "Hey Luna" leva ~700-900 ms e só conclui
depois da frase. Primeiro áudio possível no servidor: ~1,4-1,6 s dentro da janela.

**Estes números não foram medidos no hardware** — são aritmética sobre as
constantes do `config.h`. Não havia satélite disponível quando o marco foi
implementado, e as constantes carregam comentário datado dizendo isso. Calibrar
como os `WAKE_LISTEN_*` foram.

O log de `alarm_dismissed` carrega `listen_offset_ms` justamente para essa
calibração: é onde, dentro da janela, a dispensa efetivamente chegou.

### 4. Barge-in a partir da fala do usuário, não do áudio recebido

Uma rajada disparada com o satélite em `ACTIVE_STREAMING` faz o firmware dar
`xQueueReset(txQueue)` e **corta a frase do usuário** pela metade.

O guard óbvio seria "chegou áudio desta sala nos últimos N ms". **Não funciona:** em
open-mic o satélite transmite continuamente (`ACTIVE_STREAMING` é permanente quando
a wake word está indisponível, e é o modo do `luna-desktop` e do
`luna-client-test --mic`). Esse marco seria sempre "agora" e o alarme **nunca
tocaria** — a mesma armadilha que o `TtfabTracker` já documenta para a âncora de
latência.

O sinal certo é a **transcrição de entrada do provider** (`onUserSpeech`), que só
dispara com fala de verdade.

Mesmo assim há teto: passado `RING_MAX_DEFER_MS`, a rajada sai por cima da fala do
usuário. Um cômodo genuinamente barulhento não pode significar um alarme que nunca
toca — mas nunca por cima da fala da **própria Luna**, que intercalaria frames no
meio da resposta dela.

### 5. Fala pré-renderizada; `speak()` ao vivo é fallback

Sintetizar no instante do disparo poria até `providerConnectTimeoutMs` mais o
round-trip do modelo no caminho crítico, e o Gemini derruba sessão ociosa — um
alarme das 7h sempre pagaria um `connect`.

Então o PCM16 do lembrete é **pré-renderizado na criação** e guardado como BLOB. No
disparo o servidor só enfileira bytes: pontualidade determinística, funciona com o
provider fora do ar ou em rate limit.

O port ganha `speak(instruction): Promise<boolean>`. O `boolean` existe porque
nenhum dos adapters expõe "a sessão está viva", e o caminho do alarme **precisa**
saber que falhou para degradar para o toque só-chime.

Duas armadilhas de adapter que o contrato tem que respeitar:

- **Gemini:** `sendClientContent` injeta um turno de **usuário**, então o modelo
  parafraseia; e o `turnComplete` correspondente volta com `userText` vazio, o que
  sujaria o ring buffer da conversa.
- **OpenAI:** `speak()` compartilha o gate `pendingToolCalls.size === 0` do
  `sendToolResult`. Um `response.create` incondicional reintroduziria o bug de duas
  falas sobrepostas que aquele gate existe para prevenir. Consequência não óbvia: a
  pré-renderização **não** pode ser disparada de dentro do handler de
  `set_reminder`, onde a própria call ainda está em voo — é agendada depois do
  `sendToolResult`.

Um modo de captura no Orchestrator resolve três coisas com uma flag: o áudio da
renderização não vaza para o alto-falante, o `turnComplete` dela não suja o ring
buffer, e o fallback de dispensa por turno não desliga o alarme porque a própria
Luna falou.

### 6. Estado de alarme tem ciclo de vida próprio

Os mapas por sala do Orchestrator são limpos por `releaseRoom`. O estado do alarme
**não pode ser**: uma sala cujo provider morreu continua tendo alarmes, e
`onSessionEnded` → `releaseRoom` apagaria os timers no meio do toque.

## Consequências

### Positivas

- Um satélite ocioso é alcançável, e dois satélites no mesmo cômodo tocam os dois.
- Zero mudança de firmware e zero mudança de protocolo para uma feature que fala
  sem ter sido perguntada.
- O alarme funciona com o provider fora do ar.
- `firingRooms` passou a significar "esta sala está no meio de um toque", e o teto
  `maxConcurrent` voltou a ter o sentido que o plano lhe deu.

### Negativas

- **Durante a rajada o satélite é surdo.** A reação humana é falar *enquanto* toca,
  então a primeira tentativa se perde e o usuário aprende a esperar a pausa. Isso
  argumenta por um dispensar físico (o GPIO2 já está reservado no `config.h`), fora
  do escopo da v1.
- Sem sinal visual de alarme tocando.
- Os timings de rajada e janela são estimativa de papel até alguém medi-los.
- Um desktop na mesma sala de um satélite passa a tocar toda resposta — mudança de
  comportamento que não é bug, mas surpreende.

## Referências

- [alarmes-e-lembretes.md](../alarmes-e-lembretes.md) — decisões 8 a 16
- [protocolo-websocket.md](../protocolo-websocket.md) — contrato do envelope, fan-out
- [ADR 001](001-audio-provider-abstraction.md), [ADR 002](002-function-calling-contract.md) — emendados aqui
