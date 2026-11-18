#include "LunaWsClient.h"
#include "Auth.h"
#include "ConfigStore.h"
#include "config.h"
#include "version.h"
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

namespace LunaWsClient {

static WebSocketsClient ws;
static String roomId;
static String deviceId;
static String authSecret;
static bool authenticated = false;

// IP anunciado no último device_info desta conexão (0 = ainda não mandou).
// O loop() compara com o IP atual e reenvia se mudou (DHCP renovou com outro
// endereço sem derrubar o socket).
static uint32_t announcedIp = 0;
static uint32_t lastIpCheckMs = 0;
static const uint32_t IP_CHECK_INTERVAL_MS = 2000;

static SimpleCb authOkCb = nullptr;
static SimpleCb speakingStartCb = nullptr;
static SimpleCb speakingEndCb = nullptr;
static AudioResponseCb audioResponseCb = nullptr;
static BoolCb configBusyCb = nullptr;
static OtaStartCb otaStartCb = nullptr;

// Troca de sala aceita: a sala vem da autenticação (WsServer.ts), então a
// conexão atual precisa cair e reautenticar com o room_id novo. Adiado para o
// loop() — dá tempo do config_ack sair antes do close, e não fecha a socket de
// dentro do próprio callback de evento dela.
static uint32_t reconnectAtMs = 0;
static const uint32_t CONFIG_RECONNECT_DELAY_MS = 300;

// Frame de saída: header JSON + PCM concatenados.
// 256 de header: o `wake_clip` tem ~130 bytes de campos fixos + room_id de até 64.
static uint8_t txFrame[256 + CHUNK_BYTES];

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

// Satélite descreve a si mesmo: versão do firmware, IP, MAC e saúde barata de
// coletar. Mandado logo após auth_ok e de novo se o IP mudar. Servidor antigo
// loga como "Mensagem de controle ignorada" e segue (ver protocolo-websocket.md).
static void sendDeviceInfo() {
  const IPAddress ip = WiFi.localIP();

  JsonDocument doc;
  doc["type"] = "device_info";
  doc["room_id"] = roomId;
  doc["ts"] = (uint32_t)millis();
  doc["fw_version"] = FW_VERSION;
  doc["fw_build"] = FW_BUILD;
  doc["ip"] = ip.toString();
  doc["mac"] = WiFi.macAddress();
  doc["rssi"] = (int)WiFi.RSSI();
  doc["free_heap"] = (uint32_t)ESP.getFreeHeap();
  doc["uptime_ms"] = (uint32_t)millis();

  String out;
  serializeJson(doc, out);
  // Só marca como anunciado se saiu: senão o loop() tenta de novo em 2 s.
  if (!ws.sendTXT(out)) return;
  announcedIp = (uint32_t)ip;
  Serial.printf("[ws] device_info enviado (%s+%s, ip=%s)\n", FW_VERSION, FW_BUILD,
                ip.toString().c_str());
}

// set_config: servidor (painel) mudando a configuração em runtime. Campos
// opcionais dentro de `config`; cada um recebe ok/erro no config_ack. Hoje só
// `room_id` existe — o resto responde "não suportado", que é o que permite o
// servidor mandar campos novos antes de todo satélite saber aplicá-los.
static void handleSetConfig(JsonDocument &doc) {
  const char *requestId = doc["request_id"] | "";
  JsonObjectConst config = doc["config"].as<JsonObjectConst>();

  JsonDocument ack;
  ack["type"] = "config_ack";
  ack["room_id"] = roomId; // sala desta conexão, a que o servidor conhece
  ack["request_id"] = requestId;
  JsonObject results = ack["results"].to<JsonObject>();

  bool allOk = true;
  bool reconnect = false;
  const bool busy = configBusyCb && configBusyCb();

  if (config.isNull() || config.size() == 0) {
    allOk = false;
    ack["reason"] = "config vazia";
  } else if (busy) {
    allOk = false;
    ack["reason"] = "ocupado";
  }

  for (JsonPairConst kv : config) {
    JsonObject r = results[kv.key().c_str()].to<JsonObject>();
    if (busy) {
      r["ok"] = false;
      r["error"] = "ocupado";
      continue;
    }
    if (strcmp(kv.key().c_str(), "room_id") == 0) {
      const String next = kv.value().is<const char *>() ? String(kv.value().as<const char *>()) : String();
      if (!ConfigStore::isValidRoomId(next)) {
        r["ok"] = false;
        r["error"] = "room_id fora do formato [a-z0-9_]{1,64}";
        allOk = false;
      } else if (next == roomId) {
        r["ok"] = true; // já está nesta sala: nada a gravar nem reconectar
      } else if (!ConfigStore::setRoomId(next)) {
        r["ok"] = false;
        r["error"] = "falha ao gravar na NVS";
        allOk = false;
      } else {
        r["ok"] = true;
        Serial.printf("[cfg] sala %s -> %s (gravada na NVS) — reconectando\n", roomId.c_str(),
                      next.c_str());
        roomId = next;
        reconnect = true;
      }
    } else {
      r["ok"] = false;
      r["error"] = "não suportado";
      allOk = false;
    }
  }

  if (busy) Serial.println("[cfg] set_config recusado: satélite ocupado com um turno");

  ack["ok"] = allOk;
  ack["reconnect"] = reconnect;
  ack["ts"] = (uint32_t)millis();

  String out;
  serializeJson(ack, out);
  ws.sendTXT(out);

  if (reconnect) reconnectAtMs = millis() + CONFIG_RECONNECT_DELAY_MS;
}

// ota_start: servidor pedindo atualização de firmware (ADR 012). Responde na
// hora — ota_progress 0 se aceitou, ota_result com o motivo se recusou —, para o
// painel não confundir recusa com firmware antigo (que não responde nada).
static void handleOtaStart(JsonDocument &doc) {
  const char *url = doc["url"] | "";
  const char *version = doc["version"] | "";
  const char *sha256 = doc["sha256"] | "";
  const uint32_t size = doc["size"] | 0u;

  const char *refusal = otaStartCb ? otaStartCb(url, version, sha256, size) : "não suportado";
  if (refusal) {
    Serial.printf("[ota] ota_start %s recusado: %s\n", version, refusal);
    sendOtaResult(false, refusal);
    return;
  }
  sendOtaProgress(0);
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
    sendDeviceInfo();
    if (authOkCb) authOkCb();
  } else if (strcmp(type, "auth_error") == 0) {
    const char *reason = doc["reason"] | "desconhecido";
    Serial.printf("[ws] auth_error: %s\n", reason);
    authenticated = false;
  } else if (strcmp(type, "speaking_start") == 0) {
    if (speakingStartCb) speakingStartCb();
  } else if (strcmp(type, "speaking_end") == 0) {
    if (speakingEndCb) speakingEndCb();
  } else if (strcmp(type, "set_config") == 0) {
    if (authenticated) handleSetConfig(doc);
  } else if (strcmp(type, "ota_start") == 0) {
    if (authenticated) handleOtaStart(doc);
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
    announcedIp = 0;
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

void loop() {
  ws.loop();

  if (reconnectAtMs != 0 && (int32_t)(millis() - reconnectAtMs) >= 0) {
    reconnectAtMs = 0;
    authenticated = false;
    // O próprio WebSocketsClient reconecta (setReconnectInterval) e o
    // WStype_CONNECTED manda o auth já com o roomId novo.
    ws.disconnect();
    return;
  }

  if (!authenticated) return;
  const uint32_t now = millis();
  if (now - lastIpCheckMs < IP_CHECK_INTERVAL_MS) return;
  lastIpCheckMs = now;
  const uint32_t ip = (uint32_t)WiFi.localIP();
  if (ip != 0 && ip != announcedIp) sendDeviceInfo();
}

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

bool sendWakeClipPart(uint32_t clipId, uint16_t part, uint16_t parts, float prob,
                      bool responded, const uint8_t *pcm, size_t len) {
  if (!authenticated || len == 0) return false;

  // Sem chaves em nenhum valor: o parser do servidor acha o fim do header
  // contando chaves (invariante do contrato, ver docs/protocolo-websocket.md).
  const int headerLen = snprintf(
      (char *)txFrame, sizeof(txFrame),
      "{\"type\":\"wake_clip\",\"room_id\":\"%s\",\"clip_id\":%lu,\"part\":%u,\"parts\":%u,"
      "\"prob\":%.3f,\"responded\":%s,\"ts\":%lu}",
      roomId.c_str(), (unsigned long)clipId, (unsigned)part, (unsigned)parts, prob,
      responded ? "true" : "false", (unsigned long)millis());
  if (headerLen <= 0 || (size_t)headerLen + len > sizeof(txFrame)) return false;

  memcpy(txFrame + headerLen, pcm, len);
  return ws.sendBIN(txFrame, headerLen + len);
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
void onConfigBusy(BoolCb cb) { configBusyCb = cb; }
void onOtaStart(OtaStartCb cb) { otaStartCb = cb; }

bool sendOtaProgress(int percent) {
  if (!authenticated) return false;
  JsonDocument doc;
  doc["type"] = "ota_progress";
  doc["room_id"] = roomId;
  doc["percent"] = percent;
  doc["ts"] = (uint32_t)millis();
  String out;
  serializeJson(doc, out);
  return ws.sendTXT(out);
}

bool sendOtaResult(bool ok, const char *error) {
  if (!authenticated) return false;
  JsonDocument doc;
  doc["type"] = "ota_result";
  doc["room_id"] = roomId;
  doc["ok"] = ok;
  if (!ok && error && *error) doc["error"] = error;
  doc["ts"] = (uint32_t)millis();
  String out;
  serializeJson(doc, out);
  return ws.sendTXT(out);
}

void disconnectNow() {
  authenticated = false;
  ws.disconnect();
}

} // namespace LunaWsClient
