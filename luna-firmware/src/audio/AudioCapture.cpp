#include "AudioCapture.h"
#include "config.h"
#include <driver/i2s_std.h>

namespace AudioCapture {

static i2s_chan_handle_t rxHandle = nullptr;
static int16_t peak = 0;

bool begin() {
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chanCfg, nullptr, &rxHandle) != ESP_OK) {
    return false;
  }

  i2s_std_config_t stdCfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      // INMP441 entrega 24 bits num slot de 32 bits, formato Philips, canal esquerdo.
      .slot_cfg =
          I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = (gpio_num_t)MIC_SCK,
              .ws = (gpio_num_t)MIC_WS,
              .dout = I2S_GPIO_UNUSED,
              .din = (gpio_num_t)MIC_SD,
              .invert_flags = {false, false, false},
          },
  };
  stdCfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT; // L/R -> GND

  if (i2s_channel_init_std_mode(rxHandle, &stdCfg) != ESP_OK) {
    return false;
  }
  return i2s_channel_enable(rxHandle) == ESP_OK;
}

size_t readChunk(int16_t *out) {
  static int32_t raw[CHUNK_SAMPLES];
  size_t bytesRead = 0;

  if (i2s_channel_read(rxHandle, raw, sizeof(raw), &bytesRead, portMAX_DELAY) != ESP_OK) {
    return 0;
  }

  const size_t samples = bytesRead / sizeof(int32_t);
  int16_t localPeak = 0;
  for (size_t i = 0; i < samples; i++) {
    int32_t v = raw[i] >> MIC_SAMPLE_SHIFT; // shift aritmético preserva o sinal
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out[i] = (int16_t)v;

    const int16_t mag = out[i] < 0 ? -out[i] : out[i];
    if (mag > localPeak) localPeak = mag;
  }
  peak = localPeak;
  return samples;
}

int16_t lastPeak() { return peak; }

} // namespace AudioCapture
