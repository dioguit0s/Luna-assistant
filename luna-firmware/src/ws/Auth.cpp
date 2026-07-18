#include "Auth.h"
#include "mbedtls/md.h"

String computeAuthToken(const String &secret, const String &deviceId) {
  uint8_t hmac[32];

  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1 /* HMAC */);
  mbedtls_md_hmac_starts(&ctx, reinterpret_cast<const unsigned char *>(secret.c_str()),
                         secret.length());
  mbedtls_md_hmac_update(&ctx, reinterpret_cast<const unsigned char *>(deviceId.c_str()),
                         deviceId.length());
  mbedtls_md_hmac_finish(&ctx, hmac);
  mbedtls_md_free(&ctx);

  static const char hexchars[] = "0123456789abcdef";
  String out;
  out.reserve(64);
  for (int i = 0; i < 32; i++) {
    out += hexchars[(hmac[i] >> 4) & 0x0F];
    out += hexchars[hmac[i] & 0x0F];
  }
  return out;
}
