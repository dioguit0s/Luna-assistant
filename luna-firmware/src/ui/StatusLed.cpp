#include "StatusLed.h"
#include "config.h"
#include <Arduino.h>

namespace StatusLed {

void begin() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
}

void on() { digitalWrite(LED_PIN, HIGH); }

void off() { digitalWrite(LED_PIN, LOW); }

} // namespace StatusLed
