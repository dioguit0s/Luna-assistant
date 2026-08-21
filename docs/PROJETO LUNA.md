# PROJETO LUNA

**Documento de Arquitetura de Software e Plano de Execução**
**Versão 2.1 — Revisado em 21/08/2026 contra o código entregue**

> Este é o documento de referência da arquitetura e do porquê das escolhas. Para
> detalhe operacional, veja as notas dedicadas:
> [protocolo WebSocket](protocolo-websocket.md) ·
> [arquitetura do servidor](arquitetura-servidor.md) ·
> [onboarding](onboarding.md) · [ADRs](adr/)

***

## **1. Visão Geral do Projeto**

O **Projeto Luna** consiste no desenvolvimento de uma assistente virtual por voz totalmente personalizada e residencial, inspirada no conceito de sistemas cibernéticos integrados. O principal diferencial competitivo e técnico do projeto é a busca por **baixíssima latência (TTFAB < 800ms)** e fluidez na conversação diária, mitigando pausas artificiais comuns em assistentes comerciais de primeira geração.

A inteligência operará em uma arquitetura de computação distribuída, onde dispositivos de baixo custo e consumo energético atuam na borda capturando estímulos, enquanto um servidor centralizado e serviços dedicados de nuvem processam as regras de negócio e os fluxos cognitivos.

> **Definição de latência:** O critério de performance do projeto é o **TTFAB (Time-To-First-Audio-Byte)** — medido do último byte de áudio enviado pelo cliente até o primeiro chunk de áudio recebido de volta. A meta é inferior a **800ms**. Instrumentar com `performance.now()` no cliente de testes e logar no servidor.

***

## **2. Arquitetura de Referência**

O ecossistema Luna adota o modelo **Cliente-Servidor (Edge-to-Server)** baseado em comunicação assíncrona full-duplex via redes locais, usando protocolo **WebSocket puro (****`ws`****)** — não socket.io, que adiciona overhead de protocolo incompatível com streaming binário de baixa latência e não possui biblioteca madura para ESP32.

O fluxo de dados opera de maneira contínua da seguinte forma:

* **Nós Satélites (Borda):** O ESP32-S3 realiza a aquisição de áudio cru do ambiente via I2S (INMP441), empacotando os dados em chunks de 20ms (320 amostras a 16 kHz = 640 bytes por chunk) e os transmitindo via WebSocket com envelope de controle padronizado.
* **Canal de Transporte:** Protocolo **WebSocket sobre TCP/IP** para conexões persistentes e full-duplex. A autenticação usa um **token por dispositivo** derivado de HMAC-SHA256 (segredo base + `device_id`), armazenado na NVS do ESP32. Tokens são rotacionados a cada boot via endpoint de provisionamento no servidor.
* **Orquestrador Central:** Ecossistema Node.js (TypeScript) orientado a eventos assíncronos gerencia os buffers de áudio, o estado contextual por `room_id`, o histórico conversacional e o despacho para a camada de IA. Gera instâncias separadas de comunicação com a IA para cada `room_id` simultâneo.
* **Camada Cognitiva Multimodal:** Processamento Audio-to-Audio em tempo real via interface abstrata `IAudioProvider`, com dois adapters implementados: `GeminiLiveAdapter` e `OpenAIRealtimeAdapter`. O provider ativo é configurável por variável de ambiente, garantindo fallback sem refatoração.
* **Hub de Automação:** Home Assistant (Docker) integrado ao orquestrador via WebSocket/REST. Atuadores físicos operam via ESP32 dedicado com ESPHome, eliminando dependência de cabo serial.

### **2.1 Nota do Arquiteto: Isolamento de Contexto e AEC**

O orquestrador gerencia um metadado obrigatório `room_id` em cada requisição, garantindo contextualização espacial de comandos relativos como "Ligar luz".

O sistema implementa **AEC (Acoustic Echo Cancellation) em dois níveis:**

1. **Nível firmware (ESP32):** Ao receber o primeiro chunk de áudio de resposta, o satélite imediatamente suspende o stream de TX via flag local — sem aguardar confirmação do servidor. Um silêncio de 150ms é inserido antes de reativar a captura após o fim do áudio.
2. **Nível servidor:** O servidor envia um pacote de controle `{"type":"speaking_start","room_id":"X"}` **antes** do primeiro chunk de áudio, antecipando o evento para os satélites do cômodo.

### **2.2 Persistência de Contexto Conversacional**

O servidor mantém um **ring buffer por&#x20;****`room_id`** com os últimos 10 turnos de conversação ou 5 minutos de inatividade (o que ocorrer primeiro). Ao abrir nova conexão com a API, o histórico relevante é reenviado no system prompt. Implementação inicial com `Map` em memória; substituição por Redis quando houver múltiplos nós.

***

## **3. Stack Tecnológico Homologado**

| Componente                    | Tecnologia Escolhida                                                               | Justificativa Técnica                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orquestrador Central**      | Node.js (TypeScript) + `ws`                                                        | Event Loop ideal para I/O assíncrono intensivo e streams binários. `ws` puro elimina overhead do socket.io e é compatível com firmware ESP32. |
| **Nó de Borda (Satélite)**    | ESP32-S3 (C++ / PlatformIO)                                                        | Aceleração vetorial (esp-nn) e PSRAM nativa para a inferência da Wake Word e o pipeline de áudio dual-mode.                                   |
| **Protocolo de Áudio Físico** | I2S — 16 kHz, 16-bit PCM mono                                                      | Protocolo digital serial para áudio. Imunidade a ruídos eletromagnéticos. Chunks de 20ms (640 bytes).                                         |
| **Processamento de IA**       | Interface `IAudioProvider` com adapters para Gemini Live API e OpenAI Realtime API | Abstração de provider garante fallback sem refatoração. Latência inferida < 800ms TTFAB.                                                      |
| **Hub de Automação**          | Home Assistant (Docker)                                                            | Abstração de dispositivos e protocolos. Integrado ao orquestrador via REST/WebSocket.                                                         |
| **Atuador Físico**            | ESP32 dedicado com ESPHome                                                         | Substitui Arduino Uno + cabo serial. Opera via rede Wi-Fi, suporta múltiplos atuadores, integração nativa com Home Assistant.                 |
| **Persistência de Contexto**  | `Map` em memória (v1) / Redis (v2)                                                 | Ring buffer por room\_id com TTL de 5 minutos.                                                                                                |
| **Logs e Observabilidade**    | `pino` (Node.js) + rotação de arquivo                                              | Logs estruturados com métricas de latência por room\_id. Alerta por e-mail se satélite offline > 5 minutos.                                   |
| **Gerenciamento de Processo** | PM2 ou systemd                                                                     | Restart automático do servidor em caso de crash.                                                                                              |

***

## **4. Protocolo de Mensagens WebSocket**

Todas as mensagens de controle seguem o envelope JSON padrão abaixo. Chunks de áudio são transmitidos com o envelope JSON seguido imediatamente do payload binário (PCM raw).

```json
{ "type": "<tipo>", "room_id": "<id>", "seq": 42, "ts": 1720000000000 }
```

| Tipo             | Direção             | Descrição                                                                |
| ---------------- | ------------------- | ------------------------------------------------------------------------ |
| `auth`           | Satélite → Servidor | Handshake inicial com token HMAC-SHA256 e device\_id                     |
| `audio_chunk`    | Satélite → Servidor | Chunk de 640 bytes de PCM 16kHz mono. Campo `seq` para detecção de perda |
| `activity_end`   | Satélite → Servidor | Push-to-talk: fim de fala explícito (só com `GEMINI_MANUAL_ACTIVITY=true`) |
| `auth_ok`        | Servidor → Satélite | Token validado — o firmware reseta a FSM ao receber                       |
| `auth_error`     | Servidor → Satélite | Handshake recusado, com o motivo no campo `reason`                        |
| `speaking_start` | Servidor → Satélite | Enviado antes do primeiro chunk de resposta — ativa AEC                  |
| `audio_response` | Servidor → Satélite | Chunk de áudio de resposta sintetizada                                   |
| `speaking_end`   | Servidor → Satélite | Fim da resposta — satélite aguarda 150ms e reativa captura               |
| `command_result` | Servidor → Satélite | Resultado de execução de comando de automação                            |
| `ping` / `pong`  | Bidirecional        | Keep-alive e medição de RTT                                              |

> **Referência completa:** [`protocolo-websocket.md`](protocolo-websocket.md) — campos
> do envelope, formato dos frames, sequência de autenticação, timings e o checklist
> das **quatro** cópias do contrato no repositório. Esta tabela é o resumo; aquela
> nota é a fonte canônica.

### **4.1 Ritmo de `audio_response` e recuperação de `speaking_end`**

O `luna-server` (`Orchestrator.enqueueAudioFrames`/`drainAudioQueue`) não despeja a resposta
inteira na conexão assim que o provider (Gemini/OpenAI) a entrega — Gemini e OpenAI geram áudio
bem mais rápido que tempo real, e um envio síncrono estourava o buffer de playback do satélite
(512KB de PSRAM, ~16s a 16kHz) numa resposta longa, com o excesso descartado silenciosamente do
lado do firmware. O servidor enfileira os frames por sala e os envia no ritmo em que o
alto-falante realmente consome (`AUDIO_FRAME_INTERVAL_MS`, calculado a partir do tamanho do
frame e da taxa de amostragem); o primeiro frame de cada resposta sai imediato, para não somar
latência ao TTFAB. O campo `seq` de `audio_response` é monotônico por sala (não mais
`Date.now()`, que repetia entre frames emitidos no mesmo milissegundo).

Em espelho, `RESPONDING_TIMEOUT_MS` (20s, `luna-firmware/include/config.h`) é rearmado a cada
`audio_response` recebido (`StateMachine::noteResponseAudio()`), não só no `speaking_start`: o
teto significa "20s **sem** áudio novo chegando", não "resposta limitada a 20s". Isso preserva a
rede de segurança original (turno de fato travado no provider ainda recupera) sem cortar
respostas faladas mais longas que o teto.

Do lado do servidor, `speaking_end` agora é garantido em todo caminho de encerramento de um
turno — sucesso (`onTurnComplete`), erro do provider (`onError`), sessão encerrada
(`onSessionEnded`) e um watchdog próprio (`SPEAKING_WATCHDOG_MS`, 8s sem áudio novo, sempre menor
que o teto do firmware para o servidor recuperar primeiro). Antes, só o caminho de sucesso
mandava `speaking_end`, deixando o satélite preso em `RESPONDING` (mic mudo, wake word desligada)
até o teto do firmware nos demais casos.

***

## **5. Segurança**

### **5.1 Autenticação de Satélites**

* Cada satélite possui um `device_id` único gravado em fábrica (MAC address do ESP32-S3).
* O servidor possui um `WS_AUTH_SECRET` (variável de ambiente, nunca comittada no Git).
* O token de autenticação é `HMAC-SHA256(WS_AUTH_SECRET + device_id)`, recalculado a cada boot.
* O servidor valida o token no momento do handshake. Conexões sem token válido são encerradas imediatamente.
* O segredo base é armazenado na **NVS (Non-Volatile Storage)** do ESP32, partição protegida contra leitura por firmware não autorizado.

### **5.2 Variáveis de Ambiente**

O mínimo para o servidor subir:

```
AUDIO_PROVIDER=gemini    # ou "openai"
GEMINI_API_KEY=          # obrigatória quando AUDIO_PROVIDER=gemini
OPENAI_API_KEY=          # obrigatória quando AUDIO_PROVIDER=openai
WS_AUTH_SECRET=          # base para HMAC dos tokens dos satélites — única sem default
```

`WS_AUTH_SECRET` é a **única** variável sem default: sem ela o processo falha no boot.
As demais (~30 no total — knobs de VAD, `thinkingBudget`, Home Assistant, registro de
dispositivos, banco de lembretes) têm default utilizável e estão documentadas uma a
uma na [tabela do `luna-server/README.md`](../luna-server/README.md#variáveis-de-ambiente),
que é a referência canônica. A fonte da verdade no código é
[`config/env.ts`](../luna-server/src/config/env.ts).

O arquivo `.env` está no `.gitignore` desde o primeiro commit. `dotenv` no
desenvolvimento; em produção o systemd carrega um `EnvironmentFile` fora da release
(ver [`deploy/README.md`](../luna-server/deploy/README.md)).

***

## **6. Estrutura do Repositório**

```
luna/
├── luna-server/          # Orquestrador Node.js (TypeScript, ESM, Node >= 22.5)
│   ├── src/
│   │   ├── config/       # AppConfig — toda variável de ambiente passa aqui
│   │   ├── ws/           # WebSocket server, protocolo, auth HMAC, /health
│   │   ├── orchestrator/ # Ciclo do turno, fila de áudio, dispatch de tools
│   │   ├── rooms/        # Sessão por room_id e ring buffer de contexto
│   │   ├── providers/    # IAudioProvider, GeminiLiveAdapter, OpenAIRealtimeAdapter
│   │   ├── ha/           # Home Assistant: client e registro de dispositivos
│   │   ├── reminders/    # Alarmes e lembretes (node:sqlite, scheduler, chime)
│   │   ├── prompts/      # System prompt da Luna
│   │   ├── time/         # Relógio único do processo (America/Sao_Paulo)
│   │   ├── metrics/      # Medição de TTFAB
│   │   └── logging/      # pino
│   ├── deploy/           # activate.sh, unit systemd, runbook de deploy
│   ├── config/           # devices.json (overrides do registro)
│   └── .env.example
├── luna-firmware/        # Firmware do satélite ESP32-S3 (PlatformIO / C++)
│   ├── src/
│   │   ├── audio/        # Pipeline I2S: captura, playback
│   │   ├── wake/         # Wake word "Hey Luna" (microWakeWord / TFLite-micro)
│   │   ├── ws/           # Client WebSocket, auth HMAC, NVS, Wi-Fi
│   │   ├── fsm/          # FSM IDLE_LISTENING / ACTIVE_STREAMING / RESPONDING
│   │   └── ui/           # LED de status
│   ├── include/config.h  # Pinagem e todas as constantes de timing
│   └── platformio.ini
├── luna-desktop/         # Satélite para Windows (Electron + sidecar Python)
├── luna-firmware-actuator/  # Firmware ESP32 atuador (ESPHome YAML)
├── luna-client-test/     # Cliente de bancada: microfone do PC ou WAV
├── wake-training/        # Pipeline de treino da wake word (Docker)
├── infra/
│   └── docker-compose.yml   # Home Assistant
└── docs/                 # Vault Obsidian
    └── adr/              # Architecture Decision Records
```

> `luna-affine-mcp/` sobrou de um experimento abandonado: está vazio e fora do
> controle de versão. Não faz parte do sistema.

Mapa detalhado dos módulos do servidor em
[`arquitetura-servidor.md`](arquitetura-servidor.md).

***

## **7. Cronograma de Desenvolvimento (Épicos e Fases)**

> **Estado em 21/08/2026.** Os quatro épicos foram entregues; o texto de cada um é
> mantido como registro do escopo e dos critérios de aceite originais, não como
> trabalho pendente. As exceções estão marcadas na tabela.

| Épico | Escopo | Estado |
| ----- | ------ | ------ |
| 1 — O Cérebro | Servidor, `IAudioProvider`, ring buffer, cliente de bancada | **Entregue** |
| 2 — O Satélite | Hardware, firmware, I2S, FSM, AEC | **Entregue** — botão físico nunca foi conectado (GPIO2 reservado); a wake word do Épico 4 tornou-o desnecessário |
| 3 — Sistema Nervoso Motor | Home Assistant, ESPHome, function calling | **Entregue** — o registro de dispositivos evoluiu para descoberta automática via HA, com `devices.json` só para overrides |
| 4 — Autonomia | Wake word on-device, multi-satélite, fan-out por sala | **Entregue** — exceto a troca do `Map` por **Redis**, ainda pendente |

Fora do plano original, também entregues: o [`luna-desktop`](luna-desktop.md) (satélite
Windows) e, parcialmente, [alarmes e lembretes](alarmes-e-lembretes.md).

### **ÉPICO 1: O Cérebro da Luna (Core Backend & IA) — Fase 1**

**Objetivo:** Levantar a infraestrutura de software capaz de ouvir, processar e responder via emulação direta no servidor Ubuntu.

* Inicialização do servidor Node.js com TypeScript e WebSocket (`ws`).
* Implementação da interface `IAudioProvider` com `GeminiLiveAdapter` como provider primário e `OpenAIRealtimeAdapter` como fallback — configurável via `AUDIO_PROVIDER` no `.env`.
* Configuração do system prompt com personalidade e diretrizes da Luna.
* Implementação do ring buffer de contexto por `room_id` (10 turnos / TTL 5 minutos).
* Criação do cliente de testes local (`luna-client-test`) para simular tráfego de áudio via microfone do PC com instrumentação de latência (`performance.now()`).
* Configuração do `pino` para logs estruturados com campo `latency_ms` por requisição.

**Critério de Aceite:** Enviar áudio pelo cliente de testes e receber resposta sintetizada com **TTFAB inferior a 800ms**, medido e logado pelo servidor.

***

### **ÉPICO 2: O Satélite de Borda (Hardware & Firmware) — Fase 2**

**Objetivo:** Construir o protótipo físico inicial (Módulo Zero) e estabelecer comunicação de hardware estável.

* Montagem do circuito em protoboard: ESP32-S3 + microfone I2S INMP441 + amplificador MAX98357A.
* Desenvolvimento do firmware C++ (PlatformIO) com:
  * Conexão Wi-Fi estável com reconexão automática (backoff exponencial: 1s, 2s, 4s... até 60s máximo).
  * Autenticação HMAC-SHA256 no handshake WebSocket usando `device_id` + segredo da NVS.
  * Pipeline de áudio I2S: 16 kHz, 16-bit PCM mono, chunks de 20ms (640 bytes), campo `seq` para detecção de perda de pacotes.
  * **Máquina de estados dual-mode já estruturada:** `IDLE_LISTENING` (escuta passiva, aguarda trigger) e `ACTIVE_STREAMING` (captura e transmite áudio). Nesta fase o trigger é o botão físico; no Épico 4 será substituído pelo Wake Word sem refatoração da FSM.
  * Lógica de AEC local: ao receber `speaking_start`, suspender TX imediatamente. Ao receber `speaking_end`, aguardar 150ms antes de reativar captura.
  * Tom de aviso via speaker se servidor ficar offline por mais de 30 segundos.

**Critério de Aceite:** Pressionar botão físico, falar, e ouvir a resposta da Luna no speaker do satélite com qualidade inteligível.

***

### **ÉPICO 3: Sistema Nervoso Motor (Integração & Automação) — Fase 3**

**Objetivo:** Conectar a Luna ao mundo real através de automação residencial sem dependências físicas de cabo.

* Implantação do Home Assistant via Docker (`infra/docker-compose.yml`).
* Configuração do ESP32 atuador com **ESPHome** (substitui Arduino Uno + cabo serial), expondo entidades de switch/relay ao Home Assistant via Wi-Fi.
* Implementação de Function Calling no provider de IA para reconhecimento de intenções de comando (ex: `{"function":"control_device","device":"luz_bancada","action":"on","room_id":"sala_de_estar"}`).
* Áreas do Home Assistant definidas como fonte de verdade dos `room_id`: `sala_de_estar`, `cozinha` e `quarto`. O `area_id` do HA e o `ROOM_ID` do firmware precisam ser a mesma string — ver [`infra/README.md`](../infra/README.md).
* Integração do servidor Node.js com a API do Home Assistant para despacho dos comandos.

**Critério de Aceite:** Dizer "Luna, ligar luz de teste" e o relay do ESP32 atuador ser acionado de forma automatizada, sem cabo físico entre servidor e atuador.

***

### **ÉPICO 4: Autonomia e Escalabilidade Lunar — Fase 4**

**Objetivo:** Eliminar interações físicas e distribuir o ecossistema por múltiplos ambientes.

* Substituição do trigger de botão pela **Wake Word "Hey Luna"** rodando localmente no ESP32-S3, aproveitando a FSM dual-mode já implementada no Épico 2 — apenas o trigger muda, não a estrutura. A engine é o **microWakeWord** (TFLite-micro), e não o ESP-SR originalmente previsto: o WakeNet não tem modelo para "Luna" nem suporte a português, e customizá-lo é serviço pago. Ver [ADR 003](./adr/003-wake-word-engine.md).
* Ajustes finos nos ring buffers de rede para mitigar perdas de pacotes Wi-Fi.
* Replicação do hardware para um segundo satélite independente, validando:
  * Comutação de contexto entre cômodos (sessões isoladas por `room_id`).
  * AEC simultânea em múltiplos ambientes.
  * Logs com métricas diferenciadas por `room_id` e `device_id`.
* Substituição do `Map` em memória por **Redis** para persistência de contexto entre restarts.

**Critério de Aceite:** Chamar "Hey Luna" à distância sem botão, em dois cômodos diferentes, e obter respostas contextualizadas ao ambiente físico de origem.

***

## **8. Trabalho em Aberto**

Substitui o plano de arranque original (criação do repositório, boilerplate do
servidor, aquisição de hardware), todo concluído.

**Em andamento**

* **Alarmes e lembretes** — marcos 0 a 6 entregues (relógio único, endereçamento por
  sala, fan-out, `ReminderStore`, `ReminderScheduler`, `Chime`, `set_reminder`).
  Faltam o ciclo de toque com janela de escuta e a tool `manage_reminders`. Plano
  completo em [`alarmes-e-lembretes.md`](alarmes-e-lembretes.md).

**Pendências herdadas dos épicos**

* **Redis no lugar do `Map` em memória** (Épico 4). O contexto conversacional ainda
  não sobrevive a restart — e o CI reinicia o serviço a cada push em `main`.
* **Botão físico** (Épico 2). GPIO2 reservado, nunca conectado. Deixou de ser
  bloqueante com a wake word, mas continua sendo o escape hatch natural para
  dispensar um alarme sem falar.

**ADRs previstos**

* **005 — Persistência no `luna-server`.** Reverte uma propriedade declarada do
  sistema ("o processo não escreve em disco") e cria invariante nova de deploy.
* **006 — Agendamento server-side e contrato de tempo.**
* **007 — Áudio não solicitado e endereçamento por sala.** Emenda os ADRs 001/002 em
  vez de substituí-los.

**Dívida de documentação conhecida**

* O contrato WebSocket vive em **quatro** cópias (servidor, firmware, desktop,
  bancada) sem nenhum gerador ou teste cruzado que force a sincronia. O checklist em
  [`protocolo-websocket.md`](protocolo-websocket.md) é hoje o único controle.
* O CI só cobre `luna-server/**`. Firmware, ESPHome e wake-training dependem
  exclusivamente de revisão e teste manual.
