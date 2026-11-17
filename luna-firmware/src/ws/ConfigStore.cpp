#include "ConfigStore.h"
#include <Preferences.h>

namespace ConfigStore {

static Preferences prefs;
static const char *NAMESPACE = "luna";
// Chaves da NVS: no máximo 15 caracteres. "ws_secret" é a do antigo
// SecretStore — mudar a chave desprovisionaria todo satélite já instalado.
static const char *KEY_SSID = "wifi_ssid";
static const char *KEY_PASS = "wifi_pass";
static const char *KEY_HOST = "luna_host";
static const char *KEY_PORT = "luna_port";
static const char *KEY_ROOM = "room_id";
static const char *KEY_SECRET = "ws_secret";

static String ssid;
static String pass;
static String host;
static uint16_t port = 0;
static String room;
static String secret;

// Lê uma chave de texto, semeando-a do valor compilado quando a NVS está vazia
// (ou quando o provisionamento forçado pede). Nunca loga o valor: senha e
// segredo passariam pelo monitor serial.
static String loadString(const char *key, const char *compiled, bool force) {
  const bool hasCompiled = compiled && *compiled;
  const String stored = prefs.isKey(key) ? prefs.getString(key, "") : String();

  if (hasCompiled && (stored.length() == 0 || (force && stored != compiled))) {
    if (prefs.putString(key, compiled) > 0) {
      Serial.printf("[nvs] %s provisionado a partir do secrets.h\n", key);
    } else {
      Serial.printf("[erro] falha ao gravar %s na NVS — usando o valor compilado\n", key);
    }
    return String(compiled);
  }
  return stored;
}

static uint16_t loadPort(uint16_t compiled, bool force) {
  const uint16_t stored = prefs.isKey(KEY_PORT) ? prefs.getUShort(KEY_PORT, 0) : 0;
  if (compiled != 0 && (stored == 0 || (force && stored != compiled))) {
    if (prefs.putUShort(KEY_PORT, compiled) > 0) {
      Serial.printf("[nvs] %s provisionado a partir do secrets.h\n", KEY_PORT);
    }
    return compiled;
  }
  return stored;
}

void begin(const Compiled &c) {
  prefs.begin(NAMESPACE, false);

  ssid = loadString(KEY_SSID, c.wifiSsid, c.forceProvision);
  pass = loadString(KEY_PASS, c.wifiPass, c.forceProvision);
  host = loadString(KEY_HOST, c.lunaHost, c.forceProvision);
  port = loadPort(c.lunaPort, c.forceProvision);
  secret = loadString(KEY_SECRET, c.authSecret, c.forceProvision);

  // Sala compilada inválida não semeia nada: gravá-la só faria o servidor
  // recusar o auth em loop. A da NVS também é conferida — se uma versão futura
  // (ou corrupção) deixar lixo ali, cai para a compilada, se houver.
  const char *compiledRoom =
      (c.roomId && isValidRoomId(String(c.roomId))) ? c.roomId : nullptr;
  if (c.roomId && *c.roomId && !compiledRoom) {
    Serial.printf("[erro] ROOM_ID compilado \"%s\" fora do formato [a-z0-9_]{1,64} — ignorado\n",
                  c.roomId);
  }
  room = loadString(KEY_ROOM, compiledRoom, c.forceProvision);
  if (room.length() > 0 && !isValidRoomId(room)) {
    Serial.printf("[erro] room_id na NVS fora do formato: \"%s\"\n", room.c_str());
    room = compiledRoom ? String(compiledRoom) : String();
  }

  if (c.forceProvision) {
    Serial.println("[nvs] LUNA_FORCE_PROVISION ativo — volte para 0 depois deste boot");
  }

  // Sem valores sensíveis no log: só o que ajuda a diagnosticar.
  Serial.printf("[nvs] config: wifi=\"%s\" servidor=%s:%u sala=%s segredo=%s\n", ssid.c_str(),
                host.length() ? host.c_str() : "(vazio)", (unsigned)port,
                room.length() ? room.c_str() : "(vazia)", secret.length() ? "definido" : "AUSENTE");
}

const String &wifiSsid() { return ssid; }
const String &wifiPass() { return pass; }
const String &lunaHost() { return host; }
uint16_t lunaPort() { return port; }
const String &roomId() { return room; }
const String &authSecret() { return secret; }

bool isValidRoomId(const String &value) {
  const size_t n = value.length();
  if (n < 1 || n > 64) return false;
  for (size_t i = 0; i < n; i++) {
    const char ch = value[i];
    const bool ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
    if (!ok) return false;
  }
  return true;
}

bool setRoomId(const String &value) {
  if (!isValidRoomId(value)) return false;
  if (prefs.putString(KEY_ROOM, value) == 0) return false;
  room = value;
  return true;
}

bool setAuthSecret(const String &value) {
  if (value.length() == 0) return false;
  if (prefs.putString(KEY_SECRET, value) == 0) return false;
  secret = value;
  return true;
}

} // namespace ConfigStore
