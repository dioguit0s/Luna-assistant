#include "StatusLed.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>

namespace StatusLed {
namespace {

struct Rgb {
  uint8_t r, g, b;
};

enum class Pattern : uint8_t {
  SOLID,   // aceso fixo
  BREATHE, // fade senoidal entre `floor` e o brilho pleno
  BLINK,   // meio período aceso, meio apagado
};

struct Look {
  Rgb color;
  Pattern pattern;
  uint16_t periodMs;   // ignorado em SOLID
  uint8_t floorEnv;    // piso da envoltória em BREATHE (0..255)
  uint8_t brightPct;   // brilho do estado (0..100), sobre o brilho global
};

// Switch em vez de tabela indexada pelo enum de propósito: assim inserir um
// estado no meio do enum não desalinha silenciosamente as cores.
#if LED_NO_GREEN_PALETTE

// Paleta de contingência: o canal verde não acende com 300Ω (ver config.h), então
// aqui só existem vermelho, azul e magenta. Com uma cor a menos, quem separa os
// estados é o PADRÃO — sólido, respirando ou piscando — e não a cor.
Look lookFor(Ui s) {
  switch (s) {
  // Magenta respirando rápido. Transitório, dura só o setup().
  case Ui::BOOTING:   return {{255, 0, 255}, Pattern::BREATHE, 800,  20, 100};
  // Os dois estados de falha piscam com borda dura e rápida, que é a coisa mais
  // distante de "respirar" que o LED sabe fazer — é o que os separa de THINKING
  // e DEGRADED, que reusam as mesmas cores.
  case Ui::NO_WIFI:   return {{255, 0, 0},   Pattern::BLINK,   400,  0,  100};
  case Ui::NO_SERVER: return {{255, 0, 255}, Pattern::BLINK,   400,  0,  100};
  // Repouso: azul fraco, o ciclo mais lento de todos.
  case Ui::IDLE:      return {{0, 0, 255},   Pattern::BREATHE, 4000, 90, LED_IDLE_BRIGHTNESS_PCT};
  // Ouvindo: o único estado SÓLIDO, e no brilho máximo. Mesmo que o vermelho e o
  // azul saiam desbalanceados e o magenta puxe para um lado, "parado e forte"
  // continua inconfundível — é o estado que não pode ser lido errado.
  case Ui::LISTENING: return {{255, 0, 255}, Pattern::SOLID,   0,    0,  100};
  // Pensando: vermelho respirando. Era âmbar na paleta cheia; sem verde, o âmbar
  // já saía vermelho de qualquer jeito, então aqui isso é honesto em vez de ser
  // um acidente.
  case Ui::THINKING:  return {{255, 0, 0},   Pattern::BREATHE, 1200, 40, 100};
  case Ui::SPEAKING:  return {{0, 0, 255},   Pattern::BREATHE, 1600, 30, 100};
  case Ui::DEGRADED:  return {{255, 0, 255}, Pattern::BREATHE, 3000, 30, 100};
  }
  return {{0, 0, 0}, Pattern::SOLID, 0, 0, 0};
}

#else

// Paleta cheia: vale com ~100Ω no verde e no azul, quando os três canais têm
// folga de tensão suficiente para o brilho ser previsível.
Look lookFor(Ui s) {
  switch (s) {
  case Ui::BOOTING:   return {{255, 255, 255}, Pattern::BREATHE, 1200, 20, 100};
  case Ui::NO_WIFI:   return {{255, 0, 0},     Pattern::BLINK,   1000, 0,  100};
  case Ui::NO_SERVER: return {{255, 90, 0},    Pattern::BLINK,   2000, 0,  100};
  case Ui::IDLE:      return {{0, 0, 255},     Pattern::BREATHE, 4000, 90, LED_IDLE_BRIGHTNESS_PCT};
  case Ui::LISTENING: return {{0, 255, 0},     Pattern::SOLID,   0,    0,  100};
  case Ui::THINKING:  return {{255, 140, 0},   Pattern::BREATHE, 1200, 40, 100};
  case Ui::SPEAKING:  return {{0, 170, 255},   Pattern::BREATHE, 1600, 30, 100};
  case Ui::DEGRADED:  return {{255, 0, 255},   Pattern::BREATHE, 2500, 30, 100};
  }
  return {{0, 0, 0}, Pattern::SOLID, 0, 0, 0};
}

#endif

Ui uiState = Ui::BOOTING;
uint32_t stateSince = 0;
uint32_t lastWriteMs = 0;
bool attached = false;

// Envoltória do padrão no instante `elapsed`, em 0..255.
uint8_t envelope(const Look &look, uint32_t elapsed) {
  switch (look.pattern) {
  case Pattern::SOLID:
    return 255;
  case Pattern::BLINK:
    return (elapsed % look.periodMs) < (uint32_t)(look.periodMs / 2) ? 255 : 0;
  case Pattern::BREATHE: {
    const float phase = (float)(elapsed % look.periodMs) / (float)look.periodMs;
    const float wave = (1.0f - cosf(phase * 2.0f * (float)PI)) * 0.5f; // 0..1
    return look.floorEnv + (uint8_t)((255 - look.floorEnv) * wave);
  }
  }
  return 0;
}

void writeChannel(uint8_t pin, uint8_t value, uint8_t env, uint8_t brightPct, uint8_t gainPct) {
  uint32_t v = (uint32_t)value * env / 255;   // envoltória do padrão
  v = v * brightPct / 100;                    // brilho do estado
  v = v * LED_BRIGHTNESS_PCT / 100;           // brilho global
  v = v * gainPct / 100;                      // compensação Vf/resistor
  // Correção de gama (~2.0): o olho responde de forma logarítmica, e sem isto o
  // "respirar" parece um degrau brusco no começo e não se mexer no resto.
  const uint32_t duty = (v * v * LED_MAX_DUTY) / (255u * 255u);
  ledcWrite(pin, duty);
}

} // namespace

void begin() {
  attached = ledcAttach(LED_R_PIN, LED_PWM_FREQ_HZ, LED_PWM_BITS) &&
             ledcAttach(LED_G_PIN, LED_PWM_FREQ_HZ, LED_PWM_BITS) &&
             ledcAttach(LED_B_PIN, LED_PWM_FREQ_HZ, LED_PWM_BITS);
  if (!attached) {
    // Sem LEDC o satélite continua perfeitamente funcional — só fica sem
    // indicação visual. Não é motivo para abortar o boot, mas tem que aparecer
    // no log, senão vira "o LED novo não funciona" sem pista nenhuma.
    Serial.println("[erro] LEDC do LED RGB não inicializou — satélite segue sem indicação visual");
    return;
  }
  uiState = Ui::BOOTING;
  stateSince = millis();
  update();
}

void set(Ui state) {
  if (state == uiState) return; // não reinicia a animação em curso
  uiState = state;
  stateSince = millis();
  lastWriteMs = 0; // força a próxima escrita, sem esperar o tick de 60 Hz
}

Ui current() { return uiState; }

void update() {
  if (!attached) return;

  const uint32_t now = millis();
  if (lastWriteMs != 0 && now - lastWriteMs < 16) return; // ~60 Hz basta
  lastWriteMs = now;

  const Look look = lookFor(uiState);
  const uint8_t env = envelope(look, now - stateSince);
  writeChannel(LED_R_PIN, look.color.r, env, look.brightPct, LED_GAIN_R);
  writeChannel(LED_G_PIN, look.color.g, env, look.brightPct, LED_GAIN_G);
  writeChannel(LED_B_PIN, look.color.b, env, look.brightPct, LED_GAIN_B);
}

} // namespace StatusLed
