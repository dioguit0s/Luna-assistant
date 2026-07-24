#include "AudioPlayback.h"
#include "config.h"
#include <driver/i2s_std.h>
#include <math.h>

namespace AudioPlayback {

static i2s_chan_handle_t txHandle = nullptr;

bool begin() {
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);

  // A fila DMA entra direto na latência percebida: `playbackTask` injeta
  // silêncio sempre que não há resposta, então o DMA vive cheio e o primeiro
  // byte de áudio real toca só depois de escoar tudo que já está enfileirado.
  // O default (6 x 240 = 1440 frames) custa 90ms fixos a cada resposta.
  // 4 x 120 = 480 frames = 30ms: ainda folgado contra underrun.
  chanCfg.dma_desc_num = 4;
  chanCfg.dma_frame_num = 120;

  if (i2s_new_channel(&chanCfg, &txHandle, nullptr) != ESP_OK) {
    return false;
  }

  i2s_std_config_t stdCfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      // Estéreo: o MAX98357A com o driver I2S novo produz ruído em modo mono.
      // A amostra mono é duplicada nos dois canais em write().
      .slot_cfg =
          I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = (gpio_num_t)SPK_BCLK,
              .ws = (gpio_num_t)SPK_LRC,
              .dout = (gpio_num_t)SPK_DIN,
              .din = I2S_GPIO_UNUSED,
              .invert_flags = {false, false, false},
          },
  };

  if (i2s_channel_init_std_mode(txHandle, &stdCfg) != ESP_OK) {
    return false;
  }
  return i2s_channel_enable(txHandle) == ESP_OK;
}

void write(const uint8_t *pcm, size_t len) {
  if (!txHandle || len < 2) return;

  // Entrada é PCM16 mono; o TX está em estéreo. Duplica cada amostra em L e R.
  const int16_t *mono = reinterpret_cast<const int16_t *>(pcm);
  const size_t samples = len / 2;

  static int16_t stereo[256]; // 128 amostras mono por bloco
  size_t i = 0;
  while (i < samples) {
    size_t n = 0;
    while (n < 128 && i < samples) {
      const int16_t s = mono[i++];
      stereo[n * 2] = s;
      stereo[n * 2 + 1] = s;
      n++;
    }
    size_t written = 0;
    i2s_channel_write(txHandle, stereo, n * 2 * sizeof(int16_t), &written, portMAX_DELAY);
  }
}

void playTone(uint16_t freqHz, uint16_t durationMs) {
  if (!txHandle) return;

  const size_t totalSamples = (size_t)SAMPLE_RATE * durationMs / 1000;
  const size_t blockSamples = 256;
  int16_t block[blockSamples];
  const float step = 2.0f * (float)M_PI * freqHz / SAMPLE_RATE;
  float phase = 0.0f;

  size_t produced = 0;
  while (produced < totalSamples) {
    const size_t n = min(blockSamples, totalSamples - produced);
    for (size_t i = 0; i < n; i++) {
      block[i] = (int16_t)(sinf(phase) * 8000.0f); // amplitude moderada
      phase += step;
      if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
    }
    write((const uint8_t *)block, n * sizeof(int16_t));
    produced += n;
  }
}

size_t renderTone(int16_t *out, size_t maxSamples, uint16_t freqHz, uint16_t durationMs) {
  const size_t total = min((size_t)SAMPLE_RATE * durationMs / 1000, maxSamples);
  const float step = 2.0f * (float)M_PI * freqHz / SAMPLE_RATE;
  // Rampa de ~5ms nas pontas: um seno que começa e termina no seco vira um
  // "clique" audível no MAX98357A.
  const size_t ramp = min((size_t)(SAMPLE_RATE / 200), total / 2);
  float phase = 0.0f;

  for (size_t i = 0; i < total; i++) {
    float env = 1.0f;
    if (ramp > 0) {
      if (i < ramp) env = (float)i / ramp;
      else if (i >= total - ramp) env = (float)(total - i) / ramp;
    }
    out[i] = (int16_t)(sinf(phase) * 8000.0f * env);
    phase += step;
    if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
  }
  return total;
}

} // namespace AudioPlayback
