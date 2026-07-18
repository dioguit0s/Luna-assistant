#pragma once

// LED indicador de escuta (GPIO10).
// ON enquanto a captura está ativa; OFF enquanto a Luna responde.
namespace StatusLed {
void begin();
void on();
void off();
} // namespace StatusLed
