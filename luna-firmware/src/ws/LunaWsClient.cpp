#include "LunaWsClient.h"
#include "Auth.h"
#include "config.h"
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

namespace LunaWsClient {

static WebSocketsClient ws;
static String roomId;
static String deviceId;
static String authSecret;
static bool authenticated = false;

static SimpleCb authOkCb = nullptr;
static SimpleCb speakingStartCb = nullptr;
static SimpleCb speakingEndCb = nullptr;
static AudioResponseCb audioResponseCb = nullptr;

// Frame de saída: header JSON + PCM concatenados.
static uint8_t txFrame[192 + CHUNK_BYTES];

static void sendAuth() {
  const String token = computeAuthToken(authSecret, deviceId);

  JsonDocument doc;
  doc["type"] = "auth";
  doc["room_id"] = roomId;
  doc["device_id"] = deviceId;
  doc["token"] = token;
  doc["ts"] = (uint32_t)millis();

  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
  Serial.println("[ws] auth enviado");
}

static void handleTextFrame(const uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok) {
    return;
  }
  const char *type = doc["type"] | "";

  if (strcmp(type, "auth_ok") == 0) {
    authenticated = true;
    Serial.println("[ws] auth_ok");
    if (authOkCb) authOkCb();
  } else if (strcmp(type, "auth_error") == 0) {
    const char *reason = doc["reason"] | "desconhecido";
    Serial.printf("[ws] auth_error: %s\n", reason);
    authenticated = false;
  } else if (strcmp(type, "speaking_start") == 0) {
    if (speakingStartCb) speakingStartCb();
  } else if (strcmp(type, "speaking_end") == 0) {
    if (speakingEndCb) speakingEndCb();
  } else if (strcmp(type, "pong") == 0) {
    // keep-alive ok
  }
}

static void handleBinaryFrame(const uint8_t *payload, size_t length) {
  if (length == 0 || payload[0] != '{') return;

  // Acha o '}' que fecha o header JSON (contagem de profundidade, ciente de
  // string). Sem isto, um '{' ou '}' dentro de um valor de string do header
  // (device_id, por exemplo) fecharia no lugar errado e cortaria o PCM. O
  // servidor tem a mesma lógica em messageParser.ts — mudar uma sem a outra é
  // a mesma classe de regressão silenciosa do contrato WS (ver CLAUDE.md).
  int depth = 0;
  int jsonEnd = -1;
  bool inString = false;
  bool escaped = false;
  for (size_t i = 0; i < length; i++) {
    const uint8_t c = payload[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c == '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (c == '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c == '{') depth++;
    else if (c == '}') {
      if (--depth == 0) { jsonEnd = (int)i; break; }
    }
  }
  if (jsonEnd < 0) return;

  JsonDocument doc;
  if (deserializeJson(doc, payload, jsonEnd + 1) != DeserializationError::Ok) return;
  const char *type = doc["type"] | "";
  if (strcmp(type, "audio_response") != 0) return;

  const uint8_t *pcm = payload + jsonEnd + 1;
  const size_t pcmLen = length - (jsonEnd + 1);
  if (pcmLen > 0 && audioResponseCb) {
    audioResponseCb(pcm, pcmLen);
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    Serial.printf("[ws] conectado — autenticando (heap: %u)\n", ESP.getFreeHeap());
    authenticated = false;
    sendAuth();
    break;
  case WStype_DISCONNECTED:
    Serial.printf("[ws] desconectado (heap: %u, min: %u)\n", ESP.getFreeHeap(),
                  ESP.getMinFreeHeap());
    authenticated = false;
    break;
  case WStype_TEXT:
    handleTextFrame(payload, length);
    break;
  case WStype_BIN:
    handleBinaryFrame(payload, length);
    break;
  case WStype_ERROR:
    Serial.printf("[ws] erro (len=%u): %.*s\n", (unsigned)length, (int)length,
                  (const char *)payload);
    break;
  default:
    break;
  }
}

void begin(const char *host, uint16_t port, const char *path, const String &room,
           const String &dev, const String &secret) {
  roomId = room;
  deviceId = dev;
  authSecret = secret;

  ws.begin(host, port, path);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000); // reconexão do próprio WS a cada 2s
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() { ws.loop(); }

bool isConnected() { return ws.isConnected(); }

bool isAuthenticated() { return authenticated; }

void sendAudioChunk(uint32_t seq, const uint8_t *pcm, size_t len) {
  if (!authenticated || len == 0) return;

  const int headerLen =
      snprintf((char *)txFrame, sizeof(txFrame),
               "{\"type\":\"audio_chunk\",\"room_id\":\"%s\",\"seq\":%lu,\"ts\":%lu}",
               roomId.c_str(), (unsigned long)seq, (unsigned long)millis());
  if (headerLen <= 0 || (size_t)headerLen + len > sizeof(txFrame)) return;

  memcpy(txFrame + headerLen, pcm, len);
  ws.sendBIN(txFrame, headerLen + len);
}

void sendPing() {
  if (!authenticated) return;
  JsonDocument doc;
  doc["type"] = "ping";
  doc["room_id"] = roomId;
  doc["ts"] = (uint32_t)millis();
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void onAuthOk(SimpleCb cb) { authOkCb = cb; }
void onSpeakingStart(SimpleCb cb) { speakingStartCb = cb; }
void onSpeakingEnd(SimpleCb cb) { speakingEndCb = cb; }
void onAudioResponse(AudioResponseCb cb) { audioResponseCb = cb; }

} // namespace LunaWsClient
