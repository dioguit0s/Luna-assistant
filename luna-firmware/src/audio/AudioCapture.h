#pragma once
#include <Arduino.h>

// Captura de áudio do INMP441 via I2S0 (RX).
// Entrega chunks de CHUNK_SAMPLES amostras PCM16 mono a 16 kHz.
namespace AudioCapture {

// Inicializa o barramento I2S0. Retorna false em caso de falha.
bool begin();

// Lê um bloco de até CHUNK_SAMPLES amostras, convertendo 32-bit -> PCM16.
// `out` deve comportar CHUNK_SAMPLES int16_t. Bloqueia até haver dados (~20ms).
// Retorna a quantidade de amostras escritas em `out`.
size_t readChunk(int16_t *out);

// Nível de pico (0..32767) do último chunk lido — útil para validar o mic.
int16_t lastPeak();

} // namespace AudioCapture
