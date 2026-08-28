# Protocolo WebSocket Luna

Contrato de mensagens entre satélites (ESP32-S3, desktop, cliente de bancada) e o
`luna-server`. **Esta nota é a fonte canônica.** O contrato está implementado em
quatro cópias no repositório; qualquer mudança aqui precisa descer para todas —
mudar um lado só é regressão silenciosa.

| Cópia | Arquivo | Papel |
|---|---|---|
| Servidor | [`luna-server/src/ws/protocol.ts`](../luna-server/src/ws/protocol.ts) | Referência de tipos; o parser fica em `messageParser.ts` |
| Firmware | [`luna-firmware/src/ws/LunaWsClient.cpp`](../luna-firmware/src/ws/LunaWsClient.cpp) | ArduinoJson, `strcmp` por tipo |
| Desktop | [`luna-desktop/src/main/ws/protocol.ts`](../luna-desktop/src/main/ws/protocol.ts) | Porte do client-test com guard extra |
| Bancada | [`luna-client-test/src/protocol.ts`](../luna-client-test/src/protocol.ts) | Cliente de teste |

> **Checklist de mudança:** adicionar ou alterar um `MessageType` exige tocar as
> quatro cópias, atualizar a tabela do §4 de [`PROJETO LUNA`](PROJETO%20LUNA.md),
> e atualizar esta nota. O firmware é o único que não é coberto por CI.

***

## Transporte

- **WebSocket puro (`ws`)** sobre TCP, sem socket.io — overhead de protocolo
  incompatível com streaming binário de baixa latência, e sem lib madura no ESP32.
- Porta default **8080** (`WS_PORT`). O mesmo servidor HTTP expõe `GET /health`.
- **`maxPayload` de 64 KB.** O default do `ws` é 100 MB — um frame malformado
  alocaria isso antes de qualquer validação. O contrato real é 640 bytes de PCM
  mais um header JSON pequeno.

### Dois formatos de frame

**Frame de texto** — só o envelope JSON. Usado por todas as mensagens de controle.

**Frame binário** — envelope JSON UTF-8 **imediatamente seguido** do PCM cru, sem
prefixo de tamanho e sem separador:

```
{"type":"audio_chunk","room_id":"sala_de_estar","seq":42,"ts":1720000000000}<640 bytes de PCM16LE>
```

O receptor acha o fim do JSON **contando profundidade de chaves** a partir do byte 0
(o primeiro byte precisa ser `0x7b`, ou seja `{`). A implementação não é ciente de
strings: um valor de campo contendo chaves quebraria o parse. Nenhum campo do
envelope atual contém chaves — **é uma invariante do contrato, não um acidente.**
Ver [`messageParser.ts`](../luna-server/src/ws/messageParser.ts).

### Áudio

Entrada e saída usam o **mesmo formato**, o que torna o contrato simétrico:

| Parâmetro | Valor |
|---|---|
| Formato | PCM16 little-endian, mono |
| Taxa | 16 000 Hz |
| Chunk de entrada | 640 bytes = 320 amostras = 20 ms (`AUDIO_CHUNK_SIZE`) |
| Frame de saída | até 1024 bytes (`MAX_AUDIO_FRAME_BYTES`) |

Os adapters do Gemini e da OpenAI entregam 24 kHz e reamostram para 16 kHz antes de
chamar `onAudioResponse` (ver [`resampler.ts`](../luna-server/src/providers/utils/resampler.ts)).

O frame de **saída** é menor que o de entrada de propósito: satélites embarcados
(`arduinoWebSockets`) fecham a conexão ao receber um frame binário grande. O cliente
de bancada em Node aceita qualquer tamanho.

***

## Envelope

```json
{ "type": "<tipo>", "room_id": "<id>", "seq": 42, "ts": 1720000000000 }
```

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `type` | `MessageType` | **sim** | Tipo da mensagem. Mensagem sem `type` é descartada |
| `room_id` | `string` | **sim** | Cômodo de origem/destino. Sem ele a mensagem é descartada |
| `seq` | `number` | não | Sequência. Ver nota abaixo |
| `ts` | `number` | não | `Date.now()` do emissor. **No firmware é uptime (`millis()`), não hora de parede** — o satélite não tem NTP nem RTC |
| `device_id` | `string` | só em `auth` | Identidade do satélite (MAC do ESP32-S3) |
| `token` | `string` | só em `auth` | HMAC-SHA256 em hex |
| `reason` | `string` | só em `auth_error` | Motivo textual da recusa |
| `success` | `boolean` | só em `command_result` | Se a automação foi de fato executada |
| `device` | `string` | só em `command_result` | Dispositivo falado, como resolvido no registro |
| `action` | `on` / `off` | só em `command_result` | Ação aplicada |
| `entity_id` | `string` | só em `command_result` | Entidade acionada no Home Assistant |

**`room_id` precisa casar `/^[a-z0-9_]{1,64}$/`** e é a mesma string do `area_id` do
Home Assistant — o HA é a fonte de verdade dos cômodos. Ver [`infra/README.md`](../infra/README.md).

**Sobre `seq`:** em `audio_chunk` é o contador do satélite, para detecção de perda.
Em `audio_response` é **monotônico por sala**, mantido pelo servidor. Já foi
`Date.now()`, que repetia entre frames emitidos no mesmo milissegundo.

***

## Tipos de mensagem

### Satélite → Servidor

| Tipo | Frame | Quando |
|---|---|---|
| `auth` | texto | Primeira mensagem após conectar. **Obrigatória em até 10 s** (`AUTH_TIMEOUT_MS`), senão a conexão é encerrada |
| `audio_chunk` | **binário** | A cada 20 ms enquanto a FSM está em `ACTIVE_STREAMING` |
| `activity_end` | texto | Push-to-talk: fim de fala explícito. Só tem efeito com `GEMINI_MANUAL_ACTIVITY=true` |
| `ping` | texto | Keep-alive a cada 10 s (`PING_INTERVAL_MS`). Ignorado antes da autenticação |

### Servidor → Satélite

| Tipo | Frame | Quando |
|---|---|---|
| `auth_ok` | texto | Token validado. O firmware chama `StateMachine::reset()` ao recebê-la |
| `auth_error` | texto | Token, `device_id` ou `room_id` inválidos. Traz `reason` |
| `speaking_start` | texto | **Antes** do primeiro chunk de resposta — ativa a AEC no satélite |
| `audio_response` | **binário** | Chunk de áudio da resposta, paceado (ver abaixo) |
| `speaking_end` | texto | Fim da fala. O satélite espera 150 ms (`AEC_RESUME_DELAY_MS`) e reativa a captura |
| `command_result` | texto | Resultado de uma automação despachada ao Home Assistant |
| `pong` | texto | Resposta ao `ping` |

Mensagens de controle de tipo desconhecido são **logadas e ignoradas**, não derrubam
a conexão — é o que permite adicionar um tipo novo no servidor antes de todos os
satélites terem sido atualizados.

***

## Autenticação

```
token = HMAC-SHA256(key = WS_AUTH_SECRET, message = device_id)   // hex
```

O segredo base vive na NVS do ESP32 e no `.env` do servidor; nunca trafega pela rede.
A comparação no servidor usa `timingSafeEqual` ([`auth.ts`](../luna-server/src/ws/auth.ts)).

Sequência:

1. Satélite conecta e envia `auth` com `device_id`, `token` e `room_id`.
2. Servidor valida formato do `room_id`, presença dos campos e o HMAC.
3. Sucesso → `auth_ok`, a conexão é indexada no cômodo e o timer de auth é cancelado.
   Falha → `auth_error` com `reason` e a conexão é fechada.

Antes do `auth_ok`, **só `auth` é processada**: `audio_chunk`, `activity_end` e `ping`
de uma conexão não autenticada são descartados.

***

## Ciclo de um turno

```
satélite                              servidor                        provider
   |                                     |                                |
   | -- audio_chunk (20ms) ------------->| -- sendAudio ----------------->|
   | -- audio_chunk -------------------->|                                |
   |            :                        |<-- onUserSpeech (fragmentos) --|
   |                                     |  [USER_SILENCE_CUTOFF_MS]
   |<-- speaking_start ------------------|    (nao espera o 1o audio)
   |   LED off, TX suspenso (AEC)        |<-- onAudioResponse ------------|
   |<-- audio_response (imediato) -------|
   |<-- audio_response (rajada ate o lead)|  enche o prebuffer
   |<-- audio_response (tempo real) -----|   fila paceada por sala
   |            :                        |<-- onTurnComplete -------------|
   |<-- speaking_end --------------------|    (ultimo item da fila)
   |   [150ms] -> volta a IDLE_LISTENING |
```

### Pacing de `audio_response`

Gemini e OpenAI geram áudio **muito mais rápido que tempo real**. Despejar a resposta
inteira na socket estoura o buffer de playback do satélite (512 KB de PSRAM, ~16 s a
16 kHz) e o excesso é descartado **silenciosamente** do lado do firmware
(`xStreamBufferSend` com timeout 0).

Por isso o servidor enfileira os frames por sala e os pacea contra um **relógio de
mídia** (`audioClockByRoom` no `Orchestrator`): cada frame enviado avança o relógio
pela duração que ele **realmente carrega** (`bytes / 32` ms), e o próximo envio é
agendado para quando esse relógio ficar a menos de um *lead* à frente do relógio de
parede.

Dois detalhes desse desenho não são cosméticos, e desfazer qualquer um deles traz de
volta o áudio cortado:

- **O relógio é absoluto, não um intervalo fixo entre envios.** Um `setTimeout(32)`
  nunca dispara adiantado, só atrasado; o erro é unilateral e acumula sem nunca ser
  recuperado, deixando a entrega permanentemente abaixo das 16 000 amostras/s que o
  I2S do satélite consome. Recalcular contra `Date.now()` a cada item faz a taxa
  média convergir para tempo real.
- **Cada frame custa o que carrega, não o que caberia nele.** O último frame de cada
  chunk do provider quase nunca tem 1024 B; cobrar 32 ms por um frame de 128 B (4 ms
  de áudio) sozinho já punha a entrega 15-30% abaixo de tempo real.

**O primeiro frame de cada resposta sai imediato**, para não somar latência ao TTFAB.

#### O lead (`AUDIO_PACING_LEAD_MS`, default 250 ms)

Quanto áudio o servidor mantém adiantado em relação à reprodução. Os primeiros frames
de cada resposta saem em rajada até encher esse cushion, e só depois a entrega assenta
em tempo real.

**O lead não é latência** — o primeiro frame continua saindo imediato, o TTFAB não muda.
Ele é o prebuffer dos clientes: é o que eles consomem para absorver jitter de rede sem
que o alto-falante seque. Zerar isto (ou "otimizá-lo" para perto de zero) faz o playback
rodar na beira do underrun, que é exatamente o defeito que o lead existe para corrigir.

Precisa ficar **acima** do prebuffer do firmware (`PLAYBACK_PREBUFFER_BYTES`, 128 ms) e
do lead do desktop (`PLAYBACK_LEAD_S`, 200 ms), para que a rajada inicial já os
satisfaça; e é irrisório contra os 512 KB (~16 s) do buffer do satélite.

O `speaking_end` é o **último item da mesma fila**, nunca enviado por fora dela —
senão chegaria antes do áudio que ainda está sendo drenado.

#### Como medir

O servidor loga `audio_delivery` por turno (`frames`, `audio_ms`, `wall_ms`, `ratio`).
`ratio` abaixo de 1 é starvation garantida no cliente. O `luna-client-test` mede o mesmo
do lado do cliente (`[entrega] ... ratio`), sem precisar de hardware; o firmware conta
`underruns`/`silencio` no log de fim de resposta e o desktop loga cada salto de cursor.

### Garantias de `speaking_end`

Um satélite preso em `RESPONDING` fica **mudo e surdo**: mic desligado, wake word
desativada. Por isso `speaking_end` é garantido em **todo** caminho de encerramento
de um turno:

| Caminho | Origem |
|---|---|
| Sucesso | `onTurnComplete` |
| Erro do provider | `onError` |
| Sessão encerrada | `onSessionEnded` |
| Provider travado | Watchdog `SPEAKING_WATCHDOG_MS` (8 s sem áudio novo) |

E, como rede de segurança independente, o firmware tem `RESPONDING_TIMEOUT_MS` (20 s,
[`config.h`](../luna-firmware/include/config.h)).

**Os dois tetos são deliberadamente desiguais:** 8 s no servidor contra 20 s no
firmware, para o servidor sempre recuperar primeiro; o teto do firmware fica
reservado para quando o próprio servidor falha (crash, rede do satélite caindo).

O teto do firmware é **rearmado a cada `audio_response`** recebido
(`StateMachine::noteResponseAudio()`), não só no `speaking_start`: ele significa
"20 s **sem** áudio novo chegando", não "resposta limitada a 20 s". Sem isso, uma
resposta falada mais longa que o teto era cortada no meio do playback.

***

## AEC (cancelamento de eco) em dois níveis

1. **Firmware:** ao receber `speaking_start`, o satélite suspende o TX **imediatamente**
   via flag local, sem aguardar confirmação. Também para de alimentar o detector de
   wake word — senão a própria Luna dizendo "Luna" reacordaria o satélite no meio da
   resposta (`StateMachine::shouldDetectWake()`).
2. **Servidor:** `speaking_start` é enviado **antes** do primeiro chunk de áudio, e
   antecipado ainda mais pelo debounce de `USER_SILENCE_CUTOFF_MS` — assim que o
   usuário para de falar, sem esperar o modelo. Fecha a janela em que o LED continuava
   aceso com o comando já capturado.

Após `speaking_end`, o satélite espera `AEC_RESUME_DELAY_MS` (150 ms) antes de
recapturar, para o rabo do áudio no alto-falante não entrar no microfone.

***

## Fan-out por sala

`WsServer` mantém um índice `Map<room_id, Set<WebSocket>>` além do mapa por conexão.
Enviar para um cômodo alcança **todos** os satélites nele e devolve quantos receberam
de fato — `0` significa cômodo mudo.

Isso substituiu o modelo antigo de "último que falou", que guardava uma closure por
sala e só era populado depois que o satélite transmitia áudio. Um satélite ocioso com
wake word ativa nunca transmite nada — e era, portanto, **inalcançável** para fala
proativa (alarmes). Ver [`alarmes-e-lembretes.md`](alarmes-e-lembretes.md), decisão 12.

***

## Robustez da conexão

| Mecanismo | Valor | Onde |
|---|---|---|
| Timeout de autenticação | 10 s | `AUTH_TIMEOUT_MS`, servidor |
| Conexão parada (sem ping) | 25 s | `STALE_CONNECTION_TIMEOUT_MS`, servidor |
| Varredura de conexões paradas | 5 s | `STALE_CHECK_INTERVAL_MS`, servidor |
| Keep-alive | 10 s | `PING_INTERVAL_MS`, firmware |
| Aviso sonoro de servidor offline | 30 s | `OFFLINE_WARN_MS`, firmware |
| Backoff de reconexão Wi-Fi | 1 s até 60 s | `WIFI_BACKOFF_*`, firmware |

Uma exceção ao processar mensagem **degrada só aquela conexão** (`close(1011)`), nunca
derruba o processo — uma `unhandledRejection` sob Node 22 mataria todos os cômodos de
uma vez, não só o que causou o erro.

***

## `GET /health`

Exposto pelo mesmo servidor HTTP do WebSocket. O `activate.sh` usa este endpoint para
validar a release antes de efetivá-la — se ele não responder `200`, o deploy faz rollback.

```json
{ "status": "ok", "provider": "gemini", "clients": 2, "uptime_s": 3600 }
```

Qualquer outra rota responde `404`.

***

## Testando sem hardware

O [`luna-client-test`](../luna-client-test/README.md) fala este mesmo protocolo pelo
microfone do PC ou a partir de um WAV, e aceita frames de qualquer tamanho:

```bash
cd luna-client-test && npm run dev:mic
```

Os testes de protocolo do servidor ficam em `src/ws/*.test.ts` — `messageParser`,
`auth`, `WsServer.integration`, `WsServer.hardening` (limites e caminhos hostis) e
`WsServer.fanout` (entrega por sala).
