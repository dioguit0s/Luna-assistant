#include "OtaUpdater.h"
#include "config.h"
#include "esp_ota_ops.h"
#include "mbedtls/sha256.h"
#include <HTTPClient.h>
#include <WiFi.h>

// Core Arduino (esp32-hal-misc.c, initArduino): se esta função devolver false
// — o default fraco —, a imagem nova é marcada válida logo no boot, antes de
// qualquer prova de que funciona. Devolvendo true, a validação fica para
// OtaUpdater::onAuthenticated(). Linkagem C: o símbolo fraco vive num .c.
extern "C" bool verifyRollbackLater() { return true; }

namespace OtaUpdater {
namespace {

enum class Phase : uint8_t {
  IDLE,
  RUNNING,   // task baixando/gravando
  SUCCEEDED, // task terminou, boot trocado, resultado não consumido
  FAILED,    // task terminou com erro, resultado não consumido
  REBOOTING, // resultado ok consumido, esperando o loop() reiniciar
};

volatile Phase phase = Phase::IDLE;
volatile int percentDone = 0;
volatile uint32_t doneAtMs = 0;
// Escrito só pela task, antes de `phase` sair de RUNNING; lido só depois.
char errorText[96] = {0};

String reqUrl;
uint8_t reqSha[32];
uint32_t reqSize = 0;

bool verifyPending = false;
uint32_t bootMs = 0;

// Buffer de leitura fora da stack da task: 4 KB a menos para dimensionar.
uint8_t chunk[4096];

bool parseHex(const char *hex, uint8_t *out, size_t outLen) {
  if (!hex || strlen(hex) != outLen * 2) return false;
  for (size_t i = 0; i < outLen; i++) {
    uint8_t v = 0;
    for (int k = 0; k < 2; k++) {
      const char c = hex[i * 2 + k];
      uint8_t n;
      if (c >= '0' && c <= '9') n = c - '0';
      else if (c >= 'a' && c <= 'f') n = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') n = c - 'A' + 10;
      else return false;
      v = (uint8_t)((v << 4) | n);
    }
    out[i] = v;
  }
  return true;
}

// Corpo da task. Devolve nullptr no sucesso; senão errorText preenchido.
const char *runUpdate() {
  const esp_partition_t *target = esp_ota_get_next_update_partition(nullptr);
  if (!target) return "sem partição OTA livre";
  if (reqSize > target->size) return "imagem maior que a partição OTA";

  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(OTA_READ_TIMEOUT_MS);
  // Nada de redirect nem keep-alive: a URL é do servidor, de uso único.
  http.setReuse(false);
  if (!http.begin(client, reqUrl)) return "URL inválida";

  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    snprintf(errorText, sizeof(errorText), "download: HTTP %d", code);
    http.end();
    return errorText;
  }
  const int declared = http.getSize();
  if (declared >= 0 && (uint32_t)declared != reqSize) {
    snprintf(errorText, sizeof(errorText), "tamanho diferente do manifest (%d != %lu)", declared,
             (unsigned long)reqSize);
    http.end();
    return errorText;
  }

  // Apaga setor a setor conforme grava, em vez de apagar 6,5 MB de uma vez:
  // o loop() continua atendendo o WebSocket e mandando o progresso.
  esp_ota_handle_t handle = 0;
  esp_err_t err = esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &handle);
  if (err != ESP_OK) {
    snprintf(errorText, sizeof(errorText), "esp_ota_begin: %s", esp_err_to_name(err));
    http.end();
    return errorText;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0); // 0 = SHA-256 (não SHA-224)

  const char *failure = nullptr;
  NetworkClient *stream = http.getStreamPtr();
  uint32_t received = 0;
  uint32_t lastDataMs = millis();

  while (received < reqSize) {
    const size_t avail = stream->available();
    if (avail == 0) {
      if (!stream->connected()) {
        failure = "conexão caiu no meio do download";
        break;
      }
      if (millis() - lastDataMs > OTA_READ_TIMEOUT_MS) {
        failure = "download parado (timeout)";
        break;
      }
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    size_t want = reqSize - received;
    if (want > sizeof(chunk)) want = sizeof(chunk);
    if (want > avail) want = avail;
    const int n = stream->read(chunk, want);
    // Cede 1 tick por bloco, chegue dado ou não: com dado sem parar, esta task
    // (core 0) nunca bloquearia e o IDLE0 ficaria sem CPU — o task watchdog
    // (5 s, CHECK_IDLE_TASK_CPU0) daria panic no meio da gravação.
    vTaskDelay(1);
    if (n <= 0) {
      if (millis() - lastDataMs > OTA_READ_TIMEOUT_MS) {
        failure = "download parado (timeout)";
        break;
      }
      continue;
    }

    mbedtls_sha256_update(&sha, chunk, (size_t)n);
    err = esp_ota_write(handle, chunk, (size_t)n);
    if (err != ESP_OK) {
      snprintf(errorText, sizeof(errorText), "esp_ota_write: %s", esp_err_to_name(err));
      failure = errorText;
      break;
    }
    received += (uint32_t)n;
    lastDataMs = millis();
    // 99 no máximo: 100 só depois de conferir e trocar o boot.
    const int pct = (int)((uint64_t)received * 99 / reqSize);
    if (pct > percentDone) percentDone = pct;
  }

  // Byte sobrando além do manifest: imagem que não é a anunciada.
  if (!failure && stream->available() > 0) failure = "maior que o manifest";

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();

  if (!failure && memcmp(digest, reqSha, sizeof(digest)) != 0) failure = "sha256 diferente do manifest";

  if (failure) {
    esp_ota_abort(handle);
    return failure;
  }

  // esp_ota_end valida o formato da imagem (cabeçalho, segmentos, checksum e o
  // hash anexado pelo esptool) — segunda barreira depois do SHA-256 do manifest.
  err = esp_ota_end(handle);
  if (err != ESP_OK) {
    snprintf(errorText, sizeof(errorText), "imagem inválida: %s", esp_err_to_name(err));
    return errorText;
  }
  err = esp_ota_set_boot_partition(target);
  if (err != ESP_OK) {
    snprintf(errorText, sizeof(errorText), "troca da partição de boot: %s", esp_err_to_name(err));
    return errorText;
  }
  percentDone = 100;
  return nullptr;
}

void otaTask(void *) {
  const char *failure = runUpdate();
  if (failure && failure != errorText) {
    strncpy(errorText, failure, sizeof(errorText) - 1);
    errorText[sizeof(errorText) - 1] = 0;
  }
  doneAtMs = millis();
  __sync_synchronize(); // errorText visível antes da troca de fase
  phase = failure ? Phase::FAILED : Phase::SUCCEEDED;
  vTaskDelete(nullptr);
}

} // namespace

void beginBoot() {
  bootMs = millis();
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (running && esp_ota_get_state_partition(running, &state) == ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY) {
    verifyPending = true;
    Serial.printf("[ota] imagem nova em %s pendente de verificação — precisa autenticar em %u s, "
                  "senão volta para a anterior\n",
                  running->label, (unsigned)(OTA_VALIDATE_TIMEOUT_MS / 1000));
  }
  const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
  if (invalid) {
    Serial.printf("[ota] a imagem em %s foi revertida (não se validou) — rodando a anterior\n",
                  invalid->label);
  }
}

void onAuthenticated() {
  if (!verifyPending) return;
  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    verifyPending = false;
    Serial.println("[ota] imagem nova validada (autenticou no servidor) — rollback cancelado");
  } else {
    Serial.println("[erro] falha ao marcar a imagem como válida — tento de novo no próximo auth_ok");
  }
}

void loop() {
  if (!verifyPending) return;
  if (millis() - bootMs < OTA_VALIDATE_TIMEOUT_MS) return;
  Serial.println("[ota] imagem nova não autenticou no prazo — voltando para a anterior");
  delay(50);
  // Não retorna: marca inválida e reinicia na partição anterior.
  esp_ota_mark_app_invalid_rollback_and_reboot();
  verifyPending = false; // só se o reboot falhar (não há anterior válida)
}

bool pendingVerify() { return verifyPending; }

const char *start(const char *url, const char *version, const char *sha256Hex, uint32_t size) {
  if (phase != Phase::IDLE) return "atualização já em andamento";
  if (!url || strncmp(url, "http://", 7) != 0) return "url inválida (só http:// na LAN)";
  if (size == 0) return "tamanho inválido";
  if (!parseHex(sha256Hex, reqSha, sizeof(reqSha))) return "sha256 inválido";
  if (!WiFi.isConnected()) return "sem Wi-Fi";
  const esp_partition_t *target = esp_ota_get_next_update_partition(nullptr);
  if (!target) return "sem partição OTA livre";
  if (size > target->size) return "imagem maior que a partição OTA";

  reqUrl = url;
  reqSize = size;
  percentDone = 0;
  errorText[0] = 0;
  phase = Phase::RUNNING;

  // Core 0, prioridade abaixo do wake (2) e do playback (3): na disputa, quem
  // atrasa é o download. 6 KB de stack: HTTPClient + lwIP + mbedtls.
  if (xTaskCreatePinnedToCore(otaTask, "ota", 6144, nullptr, 1, nullptr, 0) != pdPASS) {
    phase = Phase::IDLE;
    return "sem memória para a task de OTA";
  }
  Serial.printf("[ota] baixando %s (%lu bytes) de %s\n", version ? version : "?", (unsigned long)size,
                url);
  return nullptr;
}

bool active() { return phase != Phase::IDLE; }

int progress() { return percentDone; }

bool finished() { return phase == Phase::SUCCEEDED || phase == Phase::FAILED; }

uint32_t finishedAtMs() { return doneAtMs; }

bool takeResult(bool &ok, String &error) {
  if (!finished()) return false;
  ok = phase == Phase::SUCCEEDED;
  error = ok ? String() : String(errorText);
  phase = ok ? Phase::REBOOTING : Phase::IDLE;
  if (ok) Serial.println("[ota] imagem gravada e conferida — reiniciando nela");
  else Serial.printf("[ota] atualização abandonada: %s — segue na versão atual\n", errorText);
  return true;
}

} // namespace OtaUpdater
