#pragma once
#include <Arduino.h>

// Armazenamento do segredo de autenticação na NVS (Non-Volatile Storage) do
// ESP32, conforme a seção 5.1 do PROJETO LUNA. O valor em include/secrets.h
// serve apenas para o provisionamento inicial.
namespace SecretStore {

void begin();

// Retorna o WS_AUTH_SECRET gravado na NVS. Se ainda não houver nenhum, grava
// `fallback` (valor compilado) e o retorna — provisionamento de primeiro boot.
String authSecret(const char *fallback);

// Regrava o segredo na NVS (rotação/reprovisionamento).
bool setAuthSecret(const String &secret);

} // namespace SecretStore
