#pragma once
#include <Arduino.h>

// Detecção local da wake word "Hey Luna" (microWakeWord / TFLite-micro).
//
// Não toca no I2S: recebe o PCM que o AudioCapture já leu. Isso mantém o
// captureTask como dono único do barramento e deixa o áudio continuar indo para
// o servidor sem passar por aqui.
//
// Pipeline (contrato do microWakeWord, ver models/README.md):
//   480 amostras (30ms) -> preprocessador -> 40 features int8
//   40 features -> modelo streaming -> 1 probabilidade
//   média das últimas WAKE_SLIDING_WINDOW probabilidades > WAKE_PROB_CUTOFF => wake
// A janela avança de WAKE_STEP_SAMPLES (10ms), então sai 1 inferência a cada 10ms.
namespace WakeWord {

// Carrega os dois modelos e aloca as arenas. Loga o que alocou e onde.
bool begin();

// Alimenta PCM16 mono @16kHz. Aceita qualquer tamanho de bloco.
// Chamar de UMA task só (wakeTask) — não é reentrante.
void feed(const int16_t *samples, size_t count);

// Consome o evento de detecção (one-shot: devolve true uma vez por disparo).
bool takeDetection();

// Zera a janela deslizante e o estado do modelo streaming. Chamar ao voltar
// para IDLE_LISTENING, senão as probabilidades do turno anterior contaminam a
// média e a Luna acorda sozinha logo depois de responder.
void rearm();

// --- Instrumentação (critério de aceite do Épico 4) ---
uint32_t avgInferenceUs(); // média por feature: preprocessador + streaming
uint32_t maxInferenceUs();
float cpuLoadPct();        // tempo de inferência / tempo de áudio processado
float lastProbability();
void resetStats();

// Diagnóstico do preprocessador (só útil com WAKE_DEBUG=1). Preenche a linha e
// zera os acumuladores. Retorna false se WAKE_DEBUG estiver desligado.
bool debugSnapshot(char *out, size_t len);

// Despeja as últimas ~3s de features (int8) via Serial em base64, para rodar o
// modelo isolado no desktop e comparar com o pipeline offline. No-op sem
// WAKE_DUMP_FEATURES.
void debugDumpFeatures();

} // namespace WakeWord
