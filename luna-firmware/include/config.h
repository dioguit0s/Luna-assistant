#pragma once

// ============================================================================
// Luna — Configuração de hardware e áudio do satélite (Épico 2)
// Pinagem: ver docs/PINAGEM_EPICO_2.md
// ============================================================================

// --- INMP441 (microfone I2S) — barramento I2S0 (RX) ---
#define MIC_SD 4  // SD  (DOUT) — dado do microfone  (ESP32 <- INMP441)
#define MIC_WS 5  // WS  (LRCLK) — word select        (ESP32 -> INMP441)
#define MIC_SCK 6 // SCK (BCLK) — bit clock           (ESP32 -> INMP441)
// L/R do INMP441 ligado a GND => captura no canal ESQUERDO (mono)

// --- MAX98357A (amplificador I2S) — barramento I2S1 (TX) ---
#define SPK_DIN 7   // DIN — dado de áudio  (ESP32 -> MAX98357A)
#define SPK_BCLK 16 // BCLK — bit clock     (ESP32 -> MAX98357A) [movido de GPIO8: ruído]
#define SPK_LRC 17  // LRC (WS) — word select (ESP32 -> MAX98357A) [movido de GPIO9]

// --- LED indicador de escuta ---
#define LED_PIN 10 // HIGH enquanto capturando; LOW enquanto a Luna responde

// GPIO2 reservado para o botão físico (não usado nesta rodada — open-mic)

// --- Parâmetros de áudio (devem casar com o protocolo do servidor) ---
#define SAMPLE_RATE 16000  // 16 kHz
#define CHUNK_SAMPLES 320  // 20 ms @ 16 kHz
#define CHUNK_BYTES (CHUNK_SAMPLES * 2) // 640 bytes de PCM16 mono

// Conversão INMP441 (32-bit no barramento) -> PCM16.
// Deslocamento à direita aplicado a cada amostra bruta. Ajuste na Fase A:
// valor MAIOR => mais baixo/limpo; MENOR => mais alto (risco de clipping).
#define MIC_SAMPLE_SHIFT 14

// --- Buffers / filas ---
#define TX_QUEUE_DEPTH 12          // chunks de captura aguardando envio
// Reprodução: o Gemini despeja a resposta em rajada (>100 KB em ~1s), muito mais
// rápido que o tempo real (16 KB/s). Buffer grande na PSRAM absorve a rajada.
#define PLAYBACK_BUFFER_BYTES (512 * 1024) // ~16 s @ 16k, alocado na PSRAM

// --- Timings de rede / FSM ---
#define AEC_RESUME_DELAY_MS 150    // silêncio após speaking_end antes de recapturar
#define PING_INTERVAL_MS 10000     // keep-alive
#define OFFLINE_WARN_MS 30000      // tempo offline antes do tom de aviso
#define WIFI_BACKOFF_START_MS 1000    // backoff exponencial: 1s, 2s, 4s...
#define WIFI_BACKOFF_MAX_MS 60000     // ...até 60s
#define WIFI_ATTEMPT_TIMEOUT_MS 8000  // janela mínima para uma associação concluir
