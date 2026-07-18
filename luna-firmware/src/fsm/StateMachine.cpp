#include "StateMachine.h"
#include "config.h"
#include "ui/StatusLed.h"

namespace StateMachine {

static volatile State state = State::IDLE_LISTENING;
static volatile uint32_t resumeAt = 0; // 0 = sem retorno agendado

static void enter(State next) {
  state = next;
  if (next == State::ACTIVE_STREAMING) {
    StatusLed::on();
  } else if (next == State::RESPONDING) {
    StatusLed::off();
  }
}

void begin() { enter(State::IDLE_LISTENING); }

void reset() {
  resumeAt = 0;
  enter(State::ACTIVE_STREAMING);
}

void update() {
  switch (state) {
  case State::IDLE_LISTENING:
    // Trigger sempre verdadeiro nesta rodada (open-mic).
    enter(State::ACTIVE_STREAMING);
    break;
  case State::RESPONDING:
    if (resumeAt != 0 && (int32_t)(millis() - resumeAt) >= 0) {
      resumeAt = 0;
      enter(State::ACTIVE_STREAMING);
    }
    break;
  default:
    break;
  }
}

State current() { return state; }

bool shouldStream() { return state == State::ACTIVE_STREAMING; }

void onSpeakingStart() {
  resumeAt = 0;
  enter(State::RESPONDING);
}

void onSpeakingEnd() {
  // Aguarda o silêncio de AEC antes de voltar a capturar.
  resumeAt = millis() + AEC_RESUME_DELAY_MS;
  if (resumeAt == 0) resumeAt = 1; // evita colidir com o sentinela
}

} // namespace StateMachine
