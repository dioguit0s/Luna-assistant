#include <Arduino.h>
#include "config.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Crie include/secrets.h a partir de include/secrets.h.example"
#endif

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "freertos/stream_buffer.h"

#include "audio/AudioCapture.h"
#include "audio/AudioPlayback.h"
#include "fsm/StateMachine.h"
#include "ui/StatusLed.h"
#include "wake/WakeWord.h"
#include "ws/LunaWsClient.h"
#include "ws/SecretStore.h"
#include "ws/WifiManager.h"

// --- Estruturas de troca entre tasks ---
struct AudioChunk {
  int16_t samples[CHUNK_SAMPLES];
  uint16_t count;
};

static QueueHandle_t txQueue = nullptr;          // captura -> envio WS
static StreamBufferHandle_t playbackBuffer = nullptr; // recepção WS -> speaker
static StreamBufferHandle_t wakeBuffer = nullptr;     // captura -> detector de wake word
static TaskHandle_t wakeTaskHandle = nullptr;

static uint32_t seqCounter = 0;
static bool wsStarted = false;
static uint32_t lastPingMs = 0;
static uint32_t lastAuthedMs = 0;
static uint32_t lastWarnMs = 0;
static uint32_t lastWakeStatsMs = 0;

// Motivo do boot anterior. Distingue de graça três coisas que se parecem no
// comportamento e agora também no LED: queda de alimentação (o amplificador em
// rajada mais o pico de TX do Wi-Fi passam do que a porta USB entrega — ver
// seção 5 da pinagem), travamento por watchdog e crash de software. Sem isto,
// todo reset espontâneo vira "a Luna parou de responder" sem pista nenhuma, e a
// primeira suspeita cai no LED novo justamente porque ele é o que se vê.
static const char *resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
  case ESP_RST_POWERON:   return "power-on";
  case ESP_RST_EXT:       return "reset externo (botão)";
  case ESP_RST_SW:        return "reset por software";
  case ESP_RST_PANIC:     return "PANIC — exceção não tratada";
  case ESP_RST_INT_WDT:   return "watchdog de interrupção";
  case ESP_RST_TASK_WDT:  return "watchdog de task";
  case ESP_RST_WDT:       return "watchdog";
  case ESP_RST_DEEPSLEEP: return "saída de deep sleep";
  case ESP_RST_BROWNOUT:  return "BROWNOUT — alimentação caiu";
  case ESP_RST_SDIO:      return "SDIO";
  default:                return "desconhecido";
  }
}

// ============================================================================
// Callbacks do servidor (executam no contexto do loop principal via ws.loop())
// ============================================================================
static void onAuthOk() {
  StateMachine::reset(); // recupera se a conexão caiu durante RESPONDING
  Serial.println("[luna] autenticado — aguardando wake word");
}

static uint32_t responseBytes = 0;
static volatile bool waitingForPlaybackDrain = false;

// Instrumentacao do playback (permanente). Sem isto nao ha como distinguir,
// pelo log, "servidor entregando abaixo de tempo real" de "Wi-Fi ruim" de
// "resampler ruim": o sintoma audivel dos tres e o mesmo buraco no meio da
// fala. Contados so em RESPONDING - silencio fora dele e o comportamento
// correto do playbackTask ocioso, nao um defeito.
static volatile uint32_t playbackUnderruns = 0;
static volatile uint32_t playbackSilenceMs = 0;

// Gate do prebuffer. Comeca aberto: fora de uma resposta (bipe de wake, tom de
// boot) nao ha o que acumular, e um gate fechado por default engoliria esses
// sons. So onSpeakingStart o fecha.
static volatile bool playbackArmed = true;
static volatile bool playbackFlushRequest = false;
static volatile uint32_t prebufferDeadlineMs = 0;

static void onSpeakingStart() {
  // AEC: para de transmitir e descarta o backlog de captura (evita eco).
  StateMachine::onSpeakingStart();
  if (txQueue) xQueueReset(txQueue);
  responseBytes = 0;
  playbackUnderruns = 0;
  playbackSilenceMs = 0;
  waitingForPlaybackDrain = false; // nova resposta supera a espera da anterior

  // Descarta a cauda da resposta ANTERIOR. Sem isto, uma resposta abortada
  // (watchdog do servidor, erro do provider) deixava audio velho no buffer e
  // ele tocava colado no inicio da resposta nova.
  //
  // Pedido, e nao xStreamBufferReset() direto: o reset falha (pdFAIL) se
  // houver task bloqueada no buffer, e o playbackTask fica bloqueado no
  // Receive quase o tempo todo. Chamado daqui (contexto do loop()) falharia
  // silenciosamente na maior parte das vezes; quem executa e o proprio
  // playbackTask, onde por definicao nao esta bloqueado.
  playbackFlushRequest = true;
  playbackArmed = false;
  prebufferDeadlineMs = millis() + PLAYBACK_PREBUFFER_MAX_WAIT_MS;
  Serial.println("[luna] respondendo (captura suspensa)");
}

static void onSpeakingEnd() {
  // Não chama StateMachine::onSpeakingEnd() ainda: esse evento é "o modelo
  // terminou de gerar", que chega em rajada — o servidor despeja >100KB de
  // áudio em ~1s, muito mais rápido que os ~16KB/s em que o playbackTask
  // realmente reproduz. Numa resposta longa, o turno server-side acaba
  // segundos antes do alto-falante. Se a captura voltasse aqui, o
  // microfone pegaria a própria resposta ainda tocando — eco reenviado ao
  // modelo, virando um loop. loop() só libera a retomada quando o buffer de
  // playback (PSRAM) realmente esvaziar.
  waitingForPlaybackDrain = true;
  // A resposta acabou: o que estiver no buffer e tudo o que havera. Se for
  // menor que o prebuffer, o gate nunca abriria sozinho pelo nivel.
  playbackArmed = true;
  Serial.printf(
      "[luna] fim da resposta (%u bytes, underruns=%u, silencio=%ums) — aguardando playback esvaziar\n",
      (unsigned)responseBytes, (unsigned)playbackUnderruns, (unsigned)playbackSilenceMs);
}

static void onAudioResponse(const uint8_t *pcm, size_t len) {
  // Rearma o teto do RESPONDING_TIMEOUT_MS a cada chunk: sem isto, uma
  // resposta mais longa que o teto (contado desde o speaking_start) era
  // cortada no meio mesmo com áudio ainda chegando do servidor.
  StateMachine::noteResponseAudio();

  responseBytes += len;
  if (!playbackBuffer) return;

  const size_t sent = xStreamBufferSend(playbackBuffer, pcm, len, 0);
  if (sent < len) {
    Serial.printf("[audio] buffer de playback cheio: %u bytes descartados\n",
                  (unsigned)(len - sent));
  }
}

// ============================================================================
// Tasks
// ============================================================================
// Pré-buffer circular dos últimos WAKE_PREROLL_MS de captura, na PSRAM.
// Só o captureTask mexe nele — não precisa de lock.
static AudioChunk *preroll = nullptr;
static size_t prerollHead = 0;  // próxima posição a escrever
static size_t prerollCount = 0; // quantos chunks válidos

static void prerollPush(const AudioChunk &chunk) {
  if (!preroll) return;
  preroll[prerollHead] = chunk;
  prerollHead = (prerollHead + 1) % WAKE_PREROLL_CHUNKS;
  if (prerollCount < WAKE_PREROLL_CHUNKS) prerollCount++;
}

// Despeja o pré-buffer na fila de envio, do mais antigo para o mais novo.
static void prerollFlush() {
  if (!preroll || prerollCount == 0) return;
  size_t idx = (prerollHead + WAKE_PREROLL_CHUNKS - prerollCount) % WAKE_PREROLL_CHUNKS;
  for (size_t i = 0; i < prerollCount; i++) {
    xQueueSend(txQueue, &preroll[idx], 0);
    idx = (idx + 1) % WAKE_PREROLL_CHUNKS;
  }
  prerollCount = 0;
}

static void captureTask(void *) {
  AudioChunk chunk;
  bool wasStreaming = false;

  for (;;) {
    chunk.count = AudioCapture::readChunk(chunk.samples); // bloqueia ~20ms
    if (chunk.count == 0) continue;

    // Alimenta a janela de escuta pós-wake com a energia do chunk (fecha por
    // silêncio se o servidor não responder).
    StateMachine::noteCapturePeak(AudioCapture::lastPeak());

    // O detector precisa do áudio mesmo (e principalmente) quando nada está
    // sendo transmitido — é justamente esse o estado de escuta passiva.
    if (wakeBuffer && StateMachine::shouldDetectWake()) {
      // Sem espera: se o wakeTask atrasou, é melhor perder um chunk de detecção
      // do que segurar o I2S e furar o tempo real da captura.
      xStreamBufferSend(wakeBuffer, chunk.samples, (size_t)chunk.count * sizeof(int16_t), 0);
    }

    const bool streaming = StateMachine::shouldStream();
    if (streaming && !wasStreaming) {
      // Acabou de acordar: manda primeiro o que já estava no pré-buffer, senão
      // o provider recebe o comando sem o começo.
      prerollFlush();
    }
    wasStreaming = streaming;

    if (streaming) {
      xQueueSend(txQueue, &chunk, 0); // descarta se a fila encher
    } else {
      prerollPush(chunk);
    }
  }
}

// Empurra o bipe de confirmação pelo caminho normal de playback. Escrever no
// I2S1 daqui disputaria o barramento com o playbackTask.
static void queueWakeChirp() {
  if (!playbackBuffer) return;
  static int16_t chirp[SAMPLE_RATE * WAKE_CHIRP_MS / 1000];
  const size_t n = AudioPlayback::renderTone(chirp, sizeof(chirp) / sizeof(chirp[0]),
                                             WAKE_CHIRP_FREQ_HZ, WAKE_CHIRP_MS);
  xStreamBufferSend(playbackBuffer, chirp, n * sizeof(int16_t), 0);
}

// Mesmo caminho seguro do bipe de wake: playTone escreveria direto no I2S1 a
// partir do loop() (core 1), disputando o barramento com o playbackTask (core
// 0) - o contrato documentado em AudioPlayback.h proibe exatamente isso.
static void queueOfflineTone() {
  if (!playbackBuffer) return;
  static int16_t tone[SAMPLE_RATE * 150 / 1000];
  const size_t n =
      AudioPlayback::renderTone(tone, sizeof(tone) / sizeof(tone[0]), 880, 150);
  xStreamBufferSend(playbackBuffer, tone, n * sizeof(int16_t), 0);
}

static void wakeTask(void *) {
  static int16_t buf[CHUNK_SAMPLES];
  bool wasDetecting = false;

  for (;;) {
    // O rearme mora aqui, e não no loop principal, porque só esta task toca no
    // estado do detector — assim não há corrida com o feed().
    const bool detecting = StateMachine::shouldDetectWake();
    if (detecting && !wasDetecting) {
      // Voltou à escuta passiva: descarta o áudio parado no buffer e zera a
      // média móvel. Sem isso as probabilidades do turno anterior sobrevivem e
      // a Luna acorda sozinha logo depois de terminar de falar.
      xStreamBufferReset(wakeBuffer);
      WakeWord::rearm();
    }
    wasDetecting = detecting;

    const size_t n = xStreamBufferReceive(wakeBuffer, buf, sizeof(buf), pdMS_TO_TICKS(100));
    if (n >= sizeof(int16_t)) {
      WakeWord::feed(buf, n / sizeof(int16_t));
    }

    if (WakeWord::takeDetection()) {
      StateMachine::onWakeWord();
      queueWakeChirp();
      Serial.println("[luna] wake word — capturando");
    }
  }
}

static void playbackTask(void *) {
  uint8_t buf[PLAYBACK_BLOCK_BYTES];
  for (;;) {
    if (playbackFlushRequest) {
      // Contexto seguro para o reset: esta task nao esta bloqueada no buffer.
      playbackFlushRequest = false;
      xStreamBufferReset(playbackBuffer);
    }

    // Gate do prebuffer: alimenta o I2S com silencio SEM consumir o buffer ate
    // haver cushion. Tres escapes, todos necessarios: nivel atingido (caso
    // normal), deadline (rede ruim) e fim da resposta (cauda mais curta que o
    // prebuffer).
    if (!playbackArmed) {
      if (xStreamBufferBytesAvailable(playbackBuffer) >= PLAYBACK_PREBUFFER_BYTES ||
          (int32_t)(millis() - prebufferDeadlineMs) >= 0 || waitingForPlaybackDrain) {
        playbackArmed = true;
      } else {
        memset(buf, 0, sizeof(buf));
        AudioPlayback::write(buf, sizeof(buf));
        continue;
      }
    }

    size_t n = xStreamBufferReceive(playbackBuffer, buf, sizeof(buf), pdMS_TO_TICKS(20));
    if (n == 0) {
      // Em RESPONDING isto e o buffer ter secado no meio de uma resposta: o
      // buraco que o usuario ouve. Contar aqui e o que torna o defeito
      // mensuravel em vez de subjetivo. Fora de RESPONDING e so ociosidade.
      if (StateMachine::current() == StateMachine::State::RESPONDING) {
        playbackUnderruns = playbackUnderruns + 1;
        playbackSilenceMs = playbackSilenceMs + PLAYBACK_BLOCK_MS;
      }
      // Sem áudio de resposta: envia SILÊNCIO ao amplificador para o DMA
      // não repetir lixo (ruído branco) enquanto ocioso.
      memset(buf, 0, sizeof(buf));
      n = sizeof(buf);
    }
    AudioPlayback::write(buf, n);
  }
}

// ============================================================================
// Indicador visual
// ============================================================================
// O LED responde a três donos que não se enxergam (Wi-Fi, WebSocket e FSM), por
// isso a decisão mora aqui e não dentro da FSM. Ordem de prioridade: uma falha
// de conectividade esconde o estado da conversa, porque nesse caso o estado da
// conversa não significa mais nada — em IDLE_LISTENING sem servidor a wake word
// dispara e o áudio não vai a lugar nenhum.
static void updateStatusLed() {
  StatusLed::Ui ui;

  if (!WifiManager::isConnected()) {
    ui = StatusLed::Ui::NO_WIFI;
  } else if (!LunaWsClient::isAuthenticated()) {
    ui = StatusLed::Ui::NO_SERVER;
  } else {
    switch (StateMachine::current()) {
    case StateMachine::State::ACTIVE_STREAMING:
      if (!StateMachine::wakeWordAvailable()) {
        // Open-mic: ACTIVE_STREAMING é permanente, então verde fixo mentiria
        // dizendo "estou te ouvindo agora" o tempo todo.
        ui = StatusLed::Ui::DEGRADED;
      } else if (StateMachine::msSinceVoice() >= LED_THINKING_AFTER_MS) {
        ui = StatusLed::Ui::THINKING;
      } else {
        ui = StatusLed::Ui::LISTENING;
      }
      break;
    case StateMachine::State::RESPONDING:
      ui = StatusLed::Ui::SPEAKING;
      break;
    case StateMachine::State::IDLE_LISTENING:
    default:
      ui = StatusLed::Ui::IDLE;
      break;
    }
  }

  StatusLed::set(ui);
  StatusLed::update();
}

// ============================================================================
// Setup / Loop
// ============================================================================
void setup() {
  Serial.begin(115200);
  // USB Serial/JTAG (HWCDC): o USB reenumera no boot e o monitor leva um instante
  // para reconectar. Sem esta espera, o banner e os primeiros logs se perdem.
  delay(1200);
  Serial.println("\n=== Luna — Satélite ESP32-S3 (Épico 2) ===");
  Serial.printf("PSRAM: %s\n", psramFound() ? "detectada" : "AUSENTE");
  Serial.printf("Boot anterior: %s\n", resetReasonStr(esp_reset_reason()));

  StatusLed::begin();
  SecretStore::begin();

  if (!AudioCapture::begin()) Serial.println("[erro] AudioCapture I2S0 falhou");
  if (!AudioPlayback::begin()) Serial.println("[erro] AudioPlayback I2S1 falhou");

  // Bipe de inicialização: sinaliza "firmware vivo" e valida o caminho de saída
  // (I2S TX -> amplificador -> speaker) com um seno limpo. Se sair ruído ou nada,
  // o problema é físico, não dos dados que chegam pela rede.
  AudioPlayback::playTone(880, 200);

  txQueue = xQueueCreate(TX_QUEUE_DEPTH, sizeof(AudioChunk));

  // Buffer de reprodução na PSRAM (grande demais para a RAM interna).
  static StaticStreamBuffer_t playbackBufferStruct;
  uint8_t *playbackStorage =
      (uint8_t *)heap_caps_malloc(PLAYBACK_BUFFER_BYTES + 1, MALLOC_CAP_SPIRAM);
  if (playbackStorage) {
    playbackBuffer = xStreamBufferCreateStatic(PLAYBACK_BUFFER_BYTES,
                                               PLAYBACK_READ_TRIGGER_BYTES, playbackStorage,
                                               &playbackBufferStruct);
  } else {
    Serial.println("[erro] PSRAM indisponível — buffer de playback reduzido");
    playbackBuffer = xStreamBufferCreate(24576, PLAYBACK_READ_TRIGGER_BYTES);
  }

  // Pré-buffer de captura na PSRAM: a RAM interna fica reservada para as arenas
  // de inferência, onde a latência importa.
  preroll = (AudioChunk *)heap_caps_malloc(sizeof(AudioChunk) * WAKE_PREROLL_CHUNKS,
                                           MALLOC_CAP_SPIRAM);
  if (!preroll) {
    preroll = (AudioChunk *)malloc(sizeof(AudioChunk) * WAKE_PREROLL_CHUNKS);
  }

#if WAKE_WORD_ENABLED
  wakeBuffer = xStreamBufferCreate(CHUNK_BYTES * 8, sizeof(int16_t));
  if (!wakeBuffer || !WakeWord::begin()) {
    // Sem detector o satélite não pode ficar mudo para sempre: cai no open-mic,
    // que é degradado mas utilizável, até alguém olhar o log.
    Serial.println("[erro] WakeWord::begin falhou — voltando ao open-mic");
    wakeBuffer = nullptr;
    StateMachine::setWakeWordAvailable(false);
  }
#else
  Serial.println("[luna] wake word desativada em config.h — open-mic");
#endif

  StateMachine::begin();

  LunaWsClient::onAuthOk(onAuthOk);
  LunaWsClient::onSpeakingStart(onSpeakingStart);
  LunaWsClient::onSpeakingEnd(onSpeakingEnd);
  LunaWsClient::onAudioResponse(onAudioResponse);

  WifiManager::begin(WIFI_SSID, WIFI_PASS);

  xTaskCreatePinnedToCore(captureTask, "capture", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(playbackTask, "playback", 4096, nullptr, 3, nullptr, 0);

  // Inferência no core 0, com prioridade ABAIXO do playback: se a CPU apertar,
  // quem atrasa é a detecção, não o áudio que está tocando.
  if (wakeBuffer) {
    xTaskCreatePinnedToCore(wakeTask, "wake", 4096, nullptr, 2, &wakeTaskHandle, 0);
  }

  lastAuthedMs = millis();
}

void loop() {
  WifiManager::loop();

  // Inicia o WebSocket assim que o Wi-Fi conectar pela primeira vez.
  if (!wsStarted && WifiManager::isConnected()) {
    LunaWsClient::begin(LUNA_HOST, LUNA_PORT, LUNA_WS_PATH, ROOM_ID,
                        WifiManager::deviceId(),
                        SecretStore::authSecret(WS_AUTH_SECRET));
    wsStarted = true;
    Serial.printf("[luna] WS -> ws://%s:%u%s\n", LUNA_HOST, (unsigned)LUNA_PORT, LUNA_WS_PATH);
  }

  if (wsStarted) LunaWsClient::loop();

  // Só entrega o "fim de resposta" à FSM quando o buffer de playback (PSRAM)
  // esvaziou de verdade — ver o porquê em onSpeakingEnd() acima. A partir daí
  // o AEC_RESUME_DELAY_MS de StateMachine cobre o resíduo de ~30ms que ainda
  // está na fila DMA do I2S mais um acomodo do ambiente.
  if (waitingForPlaybackDrain && playbackBuffer && xStreamBufferIsEmpty(playbackBuffer)) {
    waitingForPlaybackDrain = false;
    // Obrigatorio: sem isto o gate ficaria fechado depois de uma resposta e o
    // bipe de wake (queueWakeChirp) escreveria num buffer que ninguem le.
    playbackArmed = true;
    StateMachine::onSpeakingEnd();
  }

  StateMachine::update();
  updateStatusLed();

  // Drena a fila de captura, mas com orçamento de tempo. Um `while` sem limite
  // aqui reintroduz um travamento pior que o que ele resolveu: sendAudioChunk()
  // chama ws.sendBIN(), que escreve na socket TCP e pode bloquear por bem mais
  // que os ~20ms de um chunk quando o Wi-Fi degrada (sem cair de vez). Com a
  // fila de profundidade TX_QUEUE_DEPTH cheia, isso é até 12 envios bloqueantes
  // em sequência sem devolver o controle — ws.loop()/WifiManager::loop() não
  // rodam, a queda de conexão não é percebida, e a Luna "trava": para de
  // responder à voz até a socket estourar timeout sozinha. O orçamento limita
  // o estrago a ~1 envio lento por iteração; o resto sai na próxima chamada de
  // loop(), que já roda de novo em menos de 2ms (delay(1) no fim do loop).
  AudioChunk out;
  const uint32_t drainDeadline = millis() + 15;
  while ((int32_t)(millis() - drainDeadline) < 0 &&
         xQueueReceive(txQueue, &out, 0) == pdTRUE) {
    LunaWsClient::sendAudioChunk(seqCounter++, (const uint8_t *)out.samples,
                                 (size_t)out.count * sizeof(int16_t));
  }

  const uint32_t now = millis();

  // Keep-alive de aplicação.
  if (LunaWsClient::isAuthenticated() && now - lastPingMs >= PING_INTERVAL_MS) {
    LunaWsClient::sendPing();
    lastPingMs = now;
  }

  // Detecção de offline -> tom de aviso periódico no speaker.
  if (LunaWsClient::isAuthenticated()) {
    lastAuthedMs = now;
  } else if (now - lastAuthedMs > OFFLINE_WARN_MS && now - lastWarnMs > 10000) {
    Serial.println("[luna] servidor offline > 30s — tom de aviso");
    queueOfflineTone();
    lastWarnMs = now;
  }

  // Custo de manter a escuta ligada (critério de aceite do Épico 4).
  if (wakeTaskHandle && now - lastWakeStatsMs >= WAKE_STATS_INTERVAL_MS) {
    lastWakeStatsMs = now;
    Serial.printf("[wake] infer avg=%uus max=%uus load=%.1f%% p=%.2f | "
                  "heap_int=%u psram=%u stack_hwm=%u\n",
                  (unsigned)WakeWord::avgInferenceUs(), (unsigned)WakeWord::maxInferenceUs(),
                  WakeWord::cpuLoadPct(), WakeWord::lastProbability(),
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                  (unsigned)uxTaskGetStackHighWaterMark(wakeTaskHandle));
    char dbg[128];
    if (WakeWord::debugSnapshot(dbg, sizeof(dbg))) Serial.printf("[wake] %s\n", dbg);
    WakeWord::debugDumpFeatures();
    WakeWord::resetStats(); // média por janela, não desde o boot
  }

  delay(1); // cede CPU sem travar o ws.loop()
}
