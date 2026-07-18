#pragma once
#include <Arduino.h>

// Reprodução de áudio no MAX98357A via I2S1 (TX). PCM16 mono a 16 kHz.
namespace AudioPlayback {

// Inicializa o barramento I2S1. Retorna false em caso de falha.
bool begin();

// Escreve PCM16 mono no speaker (bloqueia até caber no buffer DMA).
void write(const uint8_t *pcm, size_t len);

// Toca um tom senoidal para validação de hardware (Fase B) e aviso de offline.
void playTone(uint16_t freqHz, uint16_t durationMs);

} // namespace AudioPlayback
