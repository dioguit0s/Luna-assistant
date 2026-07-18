#pragma once
#include <Arduino.h>

// Conexão Wi-Fi com reconexão automática por backoff exponencial (1s..60s).
namespace WifiManager {

void begin(const char *ssid, const char *pass);

// Chamar periodicamente no loop principal. Reconecta se necessário.
void loop();

bool isConnected();

// device_id do satélite = MAC do ESP32 (ex: "a1:b2:c3:d4:e5:f6").
String deviceId();

} // namespace WifiManager
