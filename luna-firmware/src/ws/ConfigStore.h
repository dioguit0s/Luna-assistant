#pragma once
#include <Arduino.h>

// Configuração do satélite na NVS (Non-Volatile Storage) do ESP32: Wi-Fi,
// servidor, sala e segredo de autenticação. Substitui o antigo SecretStore,
// que guardava só o segredo — mesma namespace ("luna") e mesma chave do
// segredo ("ws_secret"), então um satélite já provisionado mantém o segredo.
//
// Provisionamento: `begin()` semeia cada chave a partir do valor compilado
// (include/secrets.h) só quando a chave está vazia na NVS e o valor compilado
// não é vazio. Assim:
//   - o primeiro firmware gravado por USB, com secrets.h real, provisiona a NVS;
//   - um binário genérico (placeholders vazios, ou sem secrets.h) gravado num
//     satélite já provisionado continua usando o que está na NVS — é o que
//     permite publicar binário de OTA sem credencial nenhuma dentro.
// Dali em diante a NVS é a fonte da verdade. Para reprovisionar por USB:
// `pio run -t erase` ou LUNA_FORCE_PROVISION 1 no secrets.h (ver o .example).
namespace ConfigStore {

struct Compiled {
  const char *wifiSsid;
  const char *wifiPass;
  const char *lunaHost;
  uint16_t lunaPort; // 0 = vazio
  const char *roomId;
  const char *authSecret;
  bool forceProvision; // sobrescreve a NVS com os valores compilados não vazios
};

// Abre a NVS, semeia o que faltar e carrega tudo em memória.
void begin(const Compiled &compiled);

const String &wifiSsid();
const String &wifiPass();
const String &lunaHost();
uint16_t lunaPort();
const String &roomId();
const String &authSecret();

// Mesmo formato do servidor (ROOM_ID_PATTERN em WsServer.ts), que é o do
// area_id do Home Assistant: /^[a-z0-9_]{1,64}$/.
bool isValidRoomId(const String &roomId);

// Grava a sala na NVS e atualiza o valor em memória. Valor inválido é
// recusado (false) e o anterior fica. Falha de escrita na NVS também.
bool setRoomId(const String &roomId);

// Regrava o segredo na NVS (rotação/reprovisionamento).
bool setAuthSecret(const String &secret);

} // namespace ConfigStore
