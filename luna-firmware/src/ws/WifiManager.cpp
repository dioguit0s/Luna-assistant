#include "WifiManager.h"
#include "config.h"
#include <WiFi.h>

namespace WifiManager {

static const char *ssidStr = nullptr;
static const char *passStr = nullptr;
static uint32_t backoffMs = WIFI_BACKOFF_START_MS;
static uint32_t attemptStartedAt = 0;
static bool connecting = false;

static void startAttempt() {
  Serial.printf("[wifi] conectando a \"%s\"...\n", ssidStr);
  WiFi.disconnect();
  WiFi.begin(ssidStr, passStr);
  connecting = true;
  attemptStartedAt = millis();
}

void begin(const char *ssid, const char *pass) {
  ssidStr = ssid;
  passStr = pass;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // menor latência de rede
  startAttempt();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (connecting) {
      connecting = false;
      backoffMs = WIFI_BACKOFF_START_MS; // reset ao conectar
      Serial.printf("[wifi] conectado. IP=%s MAC=%s\n", WiFi.localIP().toString().c_str(),
                    deviceId().c_str());
    }
    return;
  }

  // Desconectado. Só tenta de novo depois que a tentativa atual teve tempo de
  // concluir — chamar WiFi.begin() com a associação em curso aborta a anterior
  // ("STA config failed"). O backoff estende essa espera a cada falha.
  const uint32_t waitMs =
      backoffMs > WIFI_ATTEMPT_TIMEOUT_MS ? backoffMs : WIFI_ATTEMPT_TIMEOUT_MS;
  if (millis() - attemptStartedAt < waitMs) return;

  startAttempt();
  backoffMs = min<uint32_t>(backoffMs * 2, WIFI_BACKOFF_MAX_MS);
}

bool isConnected() { return WiFi.status() == WL_CONNECTED; }

String deviceId() { return WiFi.macAddress(); }

} // namespace WifiManager
