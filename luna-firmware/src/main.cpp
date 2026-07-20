#include <Arduino.h>
#include "config.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Crie include/secrets.h a partir de include/secrets.h.example"
#endif

#include "esp_heap_caps.h"
#include "freertos/stream_buffer.h"

#include "audio/AudioCapture.h"
#include "audio/AudioPlayback.h"
#include "fsm/StateMachine.h"
#include "ui/StatusLed.h"
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

static uint32_t seqCounter = 0;
static bool wsStarted = false;
static uint32_t lastPingMs = 0;
static uint32_t lastAuthedMs = 0;
static uint32_t lastWarnMs = 0;

// ============================================================================
// Callbacks do servidor (executam no contexto do loop principal via ws.loop())
// ============================================================================
static void onAuthOk() {
  StateMachine::reset(); // recupera se a conexão caiu durante RESPONDING
  Serial.println("[luna] autenticado — capturando");
}

static uint32_t responseBytes = 0;

static void onSpeakingStart() {
  // AEC: para de transmitir e descarta o backlog de captura (evita eco).
  StateMachine::onSpeakingStart();
  if (txQueue) xQueueReset(txQueue);
  responseBytes = 0;
  Serial.println("[luna] respondendo (captura suspensa)");
}

static void onSpeakingEnd() {
  StateMachine::onSpeakingEnd();
  Serial.printf("[luna] fim da resposta (%u bytes)\n", (unsigned)responseBytes);
}

static void onAudioResponse(const uint8_t *pcm, size_t len) {
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
static void captureTask(void *) {
  AudioChunk chunk;
  for (;;) {
    chunk.count = AudioCapture::readChunk(chunk.samples); // bloqueia ~20ms
    if (chunk.count > 0 && StateMachine::shouldStream()) {
      xQueueSend(txQueue, &chunk, 0); // descarta se a fila encher
    }
  }
}

static void playbackTask(void *) {
  uint8_t buf[512];
  for (;;) {
    size_t n = xStreamBufferReceive(playbackBuffer, buf, sizeof(buf), pdMS_TO_TICKS(20));
    if (n == 0) {
      // Sem áudio de resposta: envia SILÊNCIO ao amplificador para o DMA
      // não repetir lixo (ruído branco) enquanto ocioso.
      memset(buf, 0, sizeof(buf));
      n = sizeof(buf);
    }
    AudioPlayback::write(buf, n);
  }
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
    playbackBuffer = xStreamBufferCreateStatic(PLAYBACK_BUFFER_BYTES, 1, playbackStorage,
                                               &playbackBufferStruct);
  } else {
    Serial.println("[erro] PSRAM indisponível — buffer de playback reduzido");
    playbackBuffer = xStreamBufferCreate(24576, 1);
  }

  StateMachine::begin();

  LunaWsClient::onAuthOk(onAuthOk);
  LunaWsClient::onSpeakingStart(onSpeakingStart);
  LunaWsClient::onSpeakingEnd(onSpeakingEnd);
  LunaWsClient::onAudioResponse(onAudioResponse);

  WifiManager::begin(WIFI_SSID, WIFI_PASS);

  xTaskCreatePinnedToCore(captureTask, "capture", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(playbackTask, "playback", 4096, nullptr, 3, nullptr, 0);

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
  StateMachine::update();

  // Drena a fila de captura por completo. O limite anterior de 4 chunks por
  // iteração (80ms de áudio) só se sustentava enquanto o loop rodasse a cada
  // 80ms; qualquer engasgo do ws.loop()/Wi-Fi acumulava backlog, e o áudio
  // chegava ao Gemini atrasado — ou era descartado pela fila de profundidade
  // TX_QUEUE_DEPTH, cortando a fala.
  AudioChunk out;
  while (xQueueReceive(txQueue, &out, 0) == pdTRUE) {
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
    AudioPlayback::playTone(880, 150);
    lastWarnMs = now;
  }

  delay(1); // cede CPU sem travar o ws.loop()
}
