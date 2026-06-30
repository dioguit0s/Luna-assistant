# PROJETO LUNA

**Documento de Arquitetura de Software e Plano de Execução**
**Versão 2.0 — Revisado com decisões arquiteturais**

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
| **Nó de Borda (Satélite)**    | ESP32-S3 (C++ / PlatformIO)                                                        | Aceleração vetorial e PSRAM nativa para ESP-SR (Wake Word) e pipeline de áudio dual-mode.                                                     |
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
| `speaking_start` | Servidor → Satélite | Enviado antes do primeiro chunk de resposta — ativa AEC                  |
| `audio_response` | Servidor → Satélite | Chunk de áudio de resposta sintetizada                                   |
| `speaking_end`   | Servidor → Satélite | Fim da resposta — satélite aguarda 150ms e reativa captura               |
| `command_result` | Servidor → Satélite | Resultado de execução de comando de automação                            |
| `ping` / `pong`  | Bidirecional        | Keep-alive e medição de RTT                                              |

***

## **5. Segurança**

### **5.1 Autenticação de Satélites**

* Cada satélite possui um `device_id` único gravado em fábrica (MAC address do ESP32-S3).
* O servidor possui um `WS_AUTH_SECRET` (variável de ambiente, nunca comittada no Git).
* O token de autenticação é `HMAC-SHA256(WS_AUTH_SECRET + device_id)`, recalculado a cada boot.
* O servidor valida o token no momento do handshake. Conexões sem token válido são encerradas imediatamente.
* O segredo base é armazenado na **NVS (Non-Volatile Storage)** do ESP32, partição protegida contra leitura por firmware não autorizado.

### **5.2 Variáveis de Ambiente Obrigatórias**

```
GEMINI_API_KEY=
OPENAI_API_KEY=          # provider de fallback
HA_TOKEN=                # token do Home Assistant
WS_AUTH_SECRET=          # base para HMAC dos tokens dos satélites
LOG_LEVEL=info
```

O arquivo `.env` deve estar no `.gitignore` desde o primeiro commit. Usar `dotenv` no desenvolvimento e variáveis de ambiente nativas em produção.

***

## **6. Estrutura do Repositório**

```
luna/
├── luna-server/          # Orquestrador Node.js (TypeScript)
│   ├── src/
│   │   ├── providers/    # IAudioProvider, GeminiLiveAdapter, OpenAIRealtimeAdapter
│   │   ├── rooms/        # Gerenciamento de room_id e ring buffer de contexto
│   │   ├── ws/           # WebSocket server e protocolo de mensagens
│   │   └── ha/           # Integração com Home Assistant
│   └── .env.example
├── luna-firmware/        # Firmware do satélite ESP32-S3 (PlatformIO / C++)
│   ├── src/
│   │   ├── audio/        # Pipeline I2S, captura, empacotamento
│   │   ├── ws/           # Client WebSocket + autenticação HMAC
│   │   └── fsm/          # Máquina de estados IDLE_LISTENING / ACTIVE_STREAMING
│   └── platformio.ini
├── luna-firmware-actuator/  # Firmware ESP32 atuador (ESPHome YAML)
├── luna-client-test/     # Cliente de testes com microfone do PC
├── infra/
│   └── docker-compose.yml   # Home Assistant + Redis
└── docs/
    └── adr/              # Architecture Decision Records
```

***

## **7. Cronograma de Desenvolvimento (Épicos e Fases)**

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
* Implementação de Function Calling no provider de IA para reconhecimento de intenções de comando (ex: `{"function":"control_device","device":"luz_bancada","action":"on","room_id":"oficina"}`).
* Integração do servidor Node.js com a API do Home Assistant para despacho dos comandos.

**Critério de Aceite:** Dizer "Luna, ligar luz de teste" e o relay do ESP32 atuador ser acionado de forma automatizada, sem cabo físico entre servidor e atuador.

***

### **ÉPICO 4: Autonomia e Escalabilidade Lunar — Fase 4**

**Objetivo:** Eliminar interações físicas e distribuir o ecossistema por múltiplos ambientes.

* Substituição do trigger de botão pelo **ESP-SR Wake Word** ("Luna") rodando localmente no ESP32-S3, aproveitando a FSM dual-mode já implementada no Épico 2 — apenas o trigger muda, não a estrutura.
* Ajustes finos nos ring buffers de rede para mitigar perdas de pacotes Wi-Fi.
* Replicação do hardware para um segundo satélite independente, validando:
  * Comutação de contexto entre cômodos (sessões isoladas por `room_id`).
  * AEC simultânea em múltiplos ambientes.
  * Logs com métricas diferenciadas por `room_id` e `device_id`.
* Substituição do `Map` em memória por **Redis** para persistência de contexto entre restarts.

**Critério de Aceite:** Chamar "Luna" à distância sem botão, em dois cômodos diferentes, e obter respostas contextualizadas ao ambiente físico de origem.

***

## **8. Próximos Passos Imediatos (Primeiras 48 Horas)**

As primeiras 48 horas focam exclusivamente no Épico 1 (software) e na aquisição de hardware:

1. Criação do repositório Git com estrutura de pastas definida na seção 6, incluindo `.gitignore` com `.env` desde o commit inicial.
2. Estruturação do boilerplate do servidor Node.js com TypeScript, `ws`, `pino` e `dotenv`.
3. Implementação da interface `IAudioProvider` com os dois adapters — definir o contrato antes de qualquer lógica de negócio.
4. Aquisição de hardware em ordem de prioridade:
   * (1) **ESP32-S3 DevKit** — bloqueante para todo o firmware
   * (2) **INMP441** (microfone I2S) — bloqueante para Épico 2
   * (3) **MAX98357A** (amplificador I2S) — pode ser validado com buzzer passivo inicialmente
   * (4) **Segundo ESP32** para atuadores — somente no Épico 3
5. Criação do primeiro ADR (`docs/adr/001-audio-provider-abstraction.md`) documentando a decisão de abstração do provider de IA.
