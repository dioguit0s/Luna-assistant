#pragma once
#include <Arduino.h>

// Calcula o token de autenticação do satélite.
// Equivalente exato a luna-server/src/ws/auth.ts:
//   HMAC-SHA256(secret, deviceId) => hex minúsculo (64 chars).
String computeAuthToken(const String &secret, const String &deviceId);
