#include "StateMachine.h"
#include "config.h"
#include "ui/StatusLed.h"

namespace StateMachine {

static volatile State state = State::IDLE_LISTENING;
static volatile uint32_t resumeAt = 0; // 0 = sem retorno agendado

// Janela de escuta pós-wake: início e último instante com fala. Usados só em
// ACTIVE_STREAMING para não ficar preso transmitindo se o servidor não responder.
static volatile uint32_t activeSince = 0;
static volatile uint32_t lastVoiceMs = 0;

// Se o detector não subir (modelo corrompido, memória insuficiente), o satélite
// não pode ficar mudo para sempre: sem wake word disponível a FSM volta ao
// open-mic, que é degradado mas utilizável, e o motivo fica no log.
static volatile bool wakeAvailable = WAKE_WORD_ENABLED;

static void enter(State next) {
  state = next;
  if (next == State::ACTIVE_STREAMING) {
    StatusLed::on();
  } else {
    // IDLE e RESPONDING compartilham o LED apagado: em ambos nada é transmitido.
    StatusLed::off();
  }
}

void begin() { enter(State::IDLE_LISTENING); }

void reset() {
  resumeAt = 0;
  enter(State::IDLE_LISTENING);
}

void update() {
  switch (state) {
  case State::IDLE_LISTENING:
    if (!wakeAvailable) enter(State::ACTIVE_STREAMING); // open-mic
    break;
  case State::ACTIVE_STREAMING: {
    // Rede de segurança: fecha a janela de escuta se o servidor não responder.
    // Só no modo wake word — no open-mic ACTIVE_STREAMING é o estado permanente.
    if (!wakeAvailable) break;
    const uint32_t now = millis();
    const bool silencio = now - lastVoiceMs > WAKE_LISTEN_SILENCE_MS;
    const bool estourou = now - activeSince > WAKE_LISTEN_MAX_MS;
    if (silencio || estourou) {
      Serial.printf("[luna] janela de escuta fechou (%s) — aguardando wake word\n",
                    estourou ? "teto" : "silêncio");
      enter(State::IDLE_LISTENING);
    }
    break;
  }
  case State::RESPONDING:
    if (resumeAt != 0 && (int32_t)(millis() - resumeAt) >= 0) {
      resumeAt = 0;
      enter(State::IDLE_LISTENING);
    }
    break;
  default:
    break;
  }
}

State current() { return state; }

bool shouldStream() { return state == State::ACTIVE_STREAMING; }

bool shouldDetectWake() { return wakeAvailable && state == State::IDLE_LISTENING; }

void setWakeWordAvailable(bool available) { wakeAvailable = available; }

void onWakeWord() {
  if (state != State::IDLE_LISTENING) return;
  resumeAt = 0;
  activeSince = millis();
  lastVoiceMs = activeSince; // começa a contar silêncio a partir do wake
  enter(State::ACTIVE_STREAMING);
}

void noteCapturePeak(int16_t peak) {
  if (state == State::ACTIVE_STREAMING && peak >= WAKE_LISTEN_VOICE_PEAK) {
    lastVoiceMs = millis();
  }
}

void onSpeakingStart() {
  resumeAt = 0;
  enter(State::RESPONDING);
}

void onSpeakingEnd() {
  // Aguarda o silêncio de AEC antes de voltar a escutar.
  resumeAt = millis() + AEC_RESUME_DELAY_MS;
  if (resumeAt == 0) resumeAt = 1; // evita colidir com o sentinela
}

} // namespace StateMachine
