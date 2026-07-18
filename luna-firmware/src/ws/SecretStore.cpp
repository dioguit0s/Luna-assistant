#include "SecretStore.h"
#include <Preferences.h>

namespace SecretStore {

static Preferences prefs;
static const char *NAMESPACE = "luna";
static const char *KEY_SECRET = "ws_secret";

void begin() { prefs.begin(NAMESPACE, false); }

String authSecret(const char *fallback) {
  const String stored = prefs.getString(KEY_SECRET, "");
  if (stored.length() > 0) {
    return stored;
  }

  if (fallback && *fallback) {
    prefs.putString(KEY_SECRET, fallback);
    Serial.println("[nvs] segredo provisionado a partir do secrets.h");
    return String(fallback);
  }

  Serial.println("[erro] nenhum segredo na NVS e nenhum fallback definido");
  return String();
}

bool setAuthSecret(const String &secret) {
  return prefs.putString(KEY_SECRET, secret) > 0;
}

} // namespace SecretStore
