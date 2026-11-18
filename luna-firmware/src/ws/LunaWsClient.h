#pragma once
#include <Arduino.h>

// Cliente WebSocket do satélite. Fala o protocolo do luna-server:
//   auth -> auth_ok | speaking_start | audio_response | speaking_end | pong
//   set_config -> config_ack (+ reconexão quando a sala muda)
//   ota_start  -> ota_progress* -> ota_result (+ reinício na imagem nova)
// Envelope de áudio = header JSON + PCM binário no MESMO frame.
namespace LunaWsClient {

typedef void (*AudioResponseCb)(const uint8_t *pcm, size_t len);
typedef void (*SimpleCb)();
typedef bool (*BoolCb)();
// Pedido de OTA já validado no formato. Devolve nullptr se aceitou (a OTA
// começou) ou o motivo da recusa, que vai no ota_result.
typedef const char *(*OtaStartCb)(const char *url, const char *version, const char *sha256,
                                  uint32_t size);

void begin(const char *host, uint16_t port, const char *path, const String &roomId,
           const String &deviceId, const String &authSecret);

// Chamar com frequência no loop principal (único dono do WebSocket).
void loop();

bool isConnected();      // TCP/handshake WS estabelecido
bool isAuthenticated();  // auth_ok recebido

// Envia um chunk de captura (header audio_chunk + PCM) num frame binário.
void sendAudioChunk(uint32_t seq, const uint8_t *pcm, size_t len);

// Envia uma parte de um clipe de wake (header wake_clip + PCM) num frame
// binário. `clipId` identifica o clipe (millis() do disparo), `part` vai de 0 a
// parts-1, em ordem. `prob` é a média que disparou; `responded` diz se o turno
// teve resposta do servidor (speaking_start) — wake sem resposta é o candidato
// mais forte a falso disparo. Retorna false se não enviou (sem auth/frame grande).
bool sendWakeClipPart(uint32_t clipId, uint16_t part, uint16_t parts, float prob,
                      bool responded, const uint8_t *pcm, size_t len);

// Envia ping de aplicação (servidor responde pong se autenticado).
void sendPing();

// Callbacks de eventos do servidor.
void onAuthOk(SimpleCb cb);
void onSpeakingStart(SimpleCb cb);
void onSpeakingEnd(SimpleCb cb);
void onAudioResponse(AudioResponseCb cb);

// Diz se o satélite está no meio de um turno. Com ele ocupado, `set_config` é
// recusado com erro "ocupado" (o painel tenta de novo) — ver ConfigStore.h e
// docs/protocolo-websocket.md. Sem callback, nunca está ocupado.
void onConfigBusy(BoolCb cb);

// ota_start do servidor (ver src/ota/OtaUpdater.h). Sem callback, recusa com
// "não suportado".
void onOtaStart(OtaStartCb cb);

// Progresso (0..100) e desfecho da OTA, antes do reinício. false = não saiu
// (sem auth ou socket cheia).
bool sendOtaProgress(int percent);
bool sendOtaResult(bool ok, const char *error);

// Fecha o WebSocket com close frame — antes de ESP.restart(), para o servidor
// liberar a sala na hora em vez de esperar o reaper.
void disconnectNow();

} // namespace LunaWsClient
