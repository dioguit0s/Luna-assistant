#pragma once
#include <Arduino.h>

// Cliente WebSocket do satélite. Fala o protocolo do luna-server:
//   auth -> auth_ok | speaking_start | audio_response | speaking_end | pong
// Envelope de áudio = header JSON + PCM binário no MESMO frame.
namespace LunaWsClient {

typedef void (*AudioResponseCb)(const uint8_t *pcm, size_t len);
typedef void (*SimpleCb)();

void begin(const char *host, uint16_t port, const char *path, const String &roomId,
           const String &deviceId, const String &authSecret);

// Chamar com frequência no loop principal (único dono do WebSocket).
void loop();

bool isConnected();      // TCP/handshake WS estabelecido
bool isAuthenticated();  // auth_ok recebido

// Envia um chunk de captura (header audio_chunk + PCM) num frame binário.
void sendAudioChunk(uint32_t seq, const uint8_t *pcm, size_t len);

// Envia ping de aplicação (servidor responde pong se autenticado).
void sendPing();

// Callbacks de eventos do servidor.
void onAuthOk(SimpleCb cb);
void onSpeakingStart(SimpleCb cb);
void onSpeakingEnd(SimpleCb cb);
void onAudioResponse(AudioResponseCb cb);

} // namespace LunaWsClient
