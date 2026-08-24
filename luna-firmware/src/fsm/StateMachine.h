#pragma once
#include <Arduino.h>

// Máquina de estados dual-mode do satélite.
// O trigger de IDLE_LISTENING -> ACTIVE_STREAMING é a wake word local
// ("Hey Luna", ver src/wake/WakeWord.h). Com WAKE_WORD_ENABLED=0 o trigger volta
// a ser sempre verdadeiro (open-mic), como era antes do Épico 4.
namespace StateMachine {

enum class State {
  IDLE_LISTENING,   // microfone aberto localmente, nada sai pela rede
  ACTIVE_STREAMING, // captura + transmite
  RESPONDING,       // Luna falando: TX suspenso (AEC)
};

void begin();

// Recoloca a FSM em escuta passiva. Chamar a cada (re)autenticação para não
// ficar preso em RESPONDING se a conexão cair no meio de uma resposta.
void reset();

// Chamar no loop principal: cuida das transições temporizadas (AEC/trigger).
void update();

State current();

// Verdadeiro quando a captura deve ser enfileirada para envio.
bool shouldStream();

// Verdadeiro quando o áudio deve alimentar o detector de wake word.
// Falso em RESPONDING de propósito: senão a própria voz da Luna dizendo "Luna"
// reacorda o satélite no meio da resposta.
bool shouldDetectWake();

// Desliga o trigger de wake word em runtime e volta ao open-mic. Chamado quando
// o detector não consegue subir — melhor degradado que mudo.
void setWakeWordAvailable(bool available);

// Espelho do anterior, para o indicador visual distinguir o modo degradado.
bool wakeWordAvailable();

// Tempo desde o último chunk com energia acima de WAKE_LISTEN_VOICE_PEAK. Em
// ACTIVE_STREAMING serve como "o usuário parou de falar" — é o que o LED usa
// para mostrar "pensando" sem precisar de um estado novo na FSM nem de uma
// mensagem nova no protocolo. Só tem sentido em ACTIVE_STREAMING: fora dele
// noteCapturePeak() não roda e o valor apenas cresce.
uint32_t msSinceVoice();

// Trigger da wake word -> ACTIVE_STREAMING (volta a transmitir).
void onWakeWord();

// Alimenta o pico de captura (0..32767) a cada chunk. Usado para fechar a janela
// de escuta pós-wake por silêncio. Chamar do captureTask.
void noteCapturePeak(int16_t peak);

// Eventos vindos do servidor.
void onSpeakingStart(); // -> RESPONDING (para TX)
void onSpeakingEnd();   // agenda retorno a IDLE_LISTENING após AEC_RESUME_DELAY_MS

// Rearma o teto do RESPONDING_TIMEOUT_MS (ver config.h): chamar a cada
// audio_response recebido do servidor, não só no speaking_start. Sem isto o
// teto conta a partir do início da resposta e ignora áudio ainda chegando —
// uma resposta mais longa que RESPONDING_TIMEOUT_MS era cortada no meio do
// playback mesmo com o provider ainda enviando. No-op fora de RESPONDING.
void noteResponseAudio();

} // namespace StateMachine
