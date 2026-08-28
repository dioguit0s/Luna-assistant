#pragma once
#include <Arduino.h>

// Reprodução de áudio no MAX98357A via I2S1 (TX). PCM16 mono a 16 kHz.
namespace AudioPlayback {

// Inicializa o barramento I2S1. Retorna false em caso de falha.
bool begin();

// Escreve PCM16 mono no speaker (bloqueia até caber no buffer DMA).
void write(const uint8_t *pcm, size_t len);

// Toca um tom senoidal para validação de hardware (Fase B), chamado do setup()
// antes do playbackTask existir. Bloqueia até terminar e escreve direto no
// I2S1 — não chamar de outra task enquanto o playbackTask estiver rodando,
// senão os dois disputam o barramento (para isso, ver renderTone abaixo).
void playTone(uint16_t freqHz, uint16_t durationMs);

// Gera o mesmo seno em memória, sem tocar no I2S, com envelope de ataque/decaimento
// para não estalar. Serve para empurrar um bipe pelo buffer de playback normal
// (caminho seguro a partir de outras tasks). Devolve quantas amostras escreveu.
size_t renderTone(int16_t *out, size_t maxSamples, uint16_t freqHz, uint16_t durationMs);

} // namespace AudioPlayback
