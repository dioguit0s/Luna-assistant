#pragma once
#include <Arduino.h>

// LED RGB de estado (cátodo comum, GPIO10/13/14 — ver docs/PINAGEM_EPICO_2.md).
//
// Substituiu o LED simples que só distinguia "capturando" de "não capturando".
// A tabela de cores e padrões vive em StatusLed.cpp; quem decide QUAL estado
// mostrar é updateStatusLed() em main.cpp, porque a decisão depende de sinais de
// três donos diferentes (Wi-Fi, WebSocket e FSM) e nenhum deles enxerga os
// outros. Por isso a FSM não fala mais com o LED.
namespace StatusLed {

enum class Ui : uint8_t {
  BOOTING,   // setup() ainda rodando
  NO_WIFI,   // sem associação Wi-Fi
  NO_SERVER, // Wi-Fi ok, mas sem auth_ok do luna-server
  IDLE,      // repouso: escuta passiva, aguardando a wake word
  LISTENING, // ouvindo: capturando e transmitindo
  THINKING,  // parou de falar, aguardando a resposta do servidor
  SPEAKING,  // Luna respondendo
  DEGRADED,  // open-mic: o detector de wake word não subiu
};

void begin();

// Idempotente: repetir o mesmo estado não reinicia a animação.
void set(Ui state);

Ui current();

// Avança a animação. Chamar a cada iteração do loop principal; internamente
// limita a escrita no LEDC a ~60 Hz.
void update();

} // namespace StatusLed
