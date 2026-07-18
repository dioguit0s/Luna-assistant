#pragma once
#include <Arduino.h>

// Máquina de estados dual-mode do satélite.
// Estrutura preservada para o Épico 4 (Wake Word/botão): apenas o "trigger"
// muda. Nesta rodada o trigger é sempre verdadeiro (open-mic).
namespace StateMachine {

enum class State {
  IDLE_LISTENING,   // aguarda trigger (nesta rodada: avança imediatamente)
  ACTIVE_STREAMING, // captura + transmite; LED ON
  RESPONDING,       // Luna falando: TX suspenso (AEC), LED OFF
};

void begin();

// Recoloca a FSM em captura (LED on). Chamar a cada (re)autenticação para
// não ficar preso em RESPONDING se a conexão cair no meio de uma resposta.
void reset();

// Chamar no loop principal: cuida das transições temporizadas (AEC/trigger).
void update();

State current();

// Verdadeiro quando a captura deve ser enfileirada para envio.
bool shouldStream();

// Eventos vindos do servidor.
void onSpeakingStart(); // -> RESPONDING (LED off, para TX)
void onSpeakingEnd();   // agenda retorno a ACTIVE_STREAMING após AEC_RESUME_DELAY_MS

} // namespace StateMachine
