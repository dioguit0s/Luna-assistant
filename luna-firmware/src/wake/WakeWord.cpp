#include "WakeWord.h"
#include "config.h"

#include "esp_heap_caps.h"
#include "esp_timer.h"

#include <new>

#include "tensorflow/lite/core/c/common.h"
#include "tensorflow/lite/kernels/internal/tensor_ctypes.h"
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include "models/audio_preprocessor_model_data.h"
#include "models/hey_luna_model_data.h"

namespace WakeWord {

// O modelo streaming guarda estado entre invocações em *variable tensors*; eles
// vivem numa arena própria, separada da de tensores. Sem o MicroResourceVariables
// o AllocateTensors() falha.
static constexpr size_t kVariableArenaBytes = 1024;
static constexpr int kMaxResourceVariables = 24;

// Nº de ops registrados em cada resolver — precisa bater exatamente com as
// chamadas Add*() abaixo, o template não cresce sozinho.
static constexpr int kPreprocOps = 18;
static constexpr int kStreamingOps = 20;

static tflite::MicroInterpreter *preprocInterp = nullptr;
static tflite::MicroInterpreter *streamInterp = nullptr;
static uint8_t *preprocArena = nullptr;
static uint8_t *streamArena = nullptr;
static uint8_t *variableArena = nullptr;

// Janela deslizante de 30ms. `pendingSamples` conta o quanto entrou desde a
// última feature; a cada WAKE_STEP_SAMPLES sai uma.
static int16_t window[WAKE_WINDOW_SAMPLES];
static size_t pendingSamples = 0;
static size_t warmupSamples = 0; // só emite feature com a janela cheia uma vez

static float recentProbs[WAKE_SLIDING_WINDOW];
static uint8_t probIndex = 0;
static uint8_t probFilled = 0;
static uint32_t ignoreWindows = 0;

// Estes modelos empilham `stride` slices de 40 features (stride = dims[1]: 2 no
// "Hey Luna", 3 no okay_nabu) e só rodam a inferência a cada `stride` slices —
// pares não-sobrepostos, como faz o componente do ESPHome. O modelo guarda o
// resto do histórico internamente (variable tensors).
static int stride = 1;
static int strideStep = 0;

static volatile bool detectedFlag = false;
static float lastProb = 0.0f;

// Estatísticas de custo. Dois acumuladores distintos de propósito:
// `totalWorkUs` soma TODO o trabalho (preprocessador de cada slice + Invoke do
// modelo quando a janela de stride fecha) e é a base do cpuLoadPct(); já
// `totalInferenceUs` soma só os slices que terminam em invocação do modelo, que
// é o universo de inferenceCount e peakInferenceUs. Misturar os dois inflava a
// média em ~stride vezes (avg saía acima do max).
static uint64_t totalWorkUs = 0;
static uint64_t totalInferenceUs = 0;
static uint32_t slicesFed = 0;    // features de 10ms processadas (base do load%)
static uint32_t inferenceCount = 0; // invocações do modelo streaming
static uint32_t peakInferenceUs = 0;

// Diagnóstico do domínio de features (WAKE_DEBUG): confirma se o preprocessador
// reage ao áudio e o quanto o modelo responde.
static int16_t dbgAudioPeak = 0;
static int8_t dbgFeatMin = 127;
static int8_t dbgFeatMax = -128;
static int32_t dbgFeatSum = 0;
static uint32_t dbgFeatN = 0;
static uint8_t dbgRawMax = 0;

#if WAKE_DUMP_FEATURES
// Ring das últimas WAKE_DUMP_SLICES features (int8) para dump por Serial.
static int8_t dumpRing[WAKE_DUMP_SLICES][WAKE_FEATURE_SIZE];
static uint32_t dumpHead = 0;
static bool dumpFilled = false;
#endif

// ============================================================================
// Alocação
// ============================================================================
// RAM interna primeiro: é onde o esp-nn rende. A PSRAM funciona, mas cada
// acesso do kernel passa pelo cache externo e a inferência fica bem mais cara.
static uint8_t *allocArena(size_t bytes, const char *tag, bool *fromPsram) {
  uint8_t *p = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (p) {
    *fromPsram = false;
    return p;
  }
  p = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
  if (p) {
    Serial.printf("[wake] arena %s (%u B) foi para a PSRAM — inferência mais lenta\n", tag,
                  (unsigned)bytes);
    *fromPsram = true;
    return p;
  }
  Serial.printf("[wake] sem memória para a arena %s (%u B)\n", tag, (unsigned)bytes);
  return nullptr;
}

static bool buildPreprocessor() {
  static tflite::MicroMutableOpResolver<kPreprocOps> resolver;
  // Ordem/conteúdo copiados do exemplo micro_speech do tflite-micro, que é de
  // onde vem este audio_preprocessor_int8.tflite.
  resolver.AddReshape();
  resolver.AddCast();
  resolver.AddStridedSlice();
  resolver.AddConcatenation();
  resolver.AddMul();
  resolver.AddAdd();
  resolver.AddDiv();
  resolver.AddMinimum();
  resolver.AddMaximum();
  resolver.AddWindow();
  resolver.AddFftAutoScale();
  resolver.AddRfft();
  resolver.AddEnergy();
  resolver.AddFilterBank();
  resolver.AddFilterBankSquareRoot();
  resolver.AddFilterBankSpectralSubtraction();
  resolver.AddPCAN();
  resolver.AddFilterBankLog();

  const tflite::Model *model = tflite::GetModel(g_audio_preprocessor_model_data);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    Serial.printf("[wake] preprocessador: schema %u != %d\n", (unsigned)model->version(),
                  TFLITE_SCHEMA_VERSION);
    return false;
  }

  // Tenta o tamanho configurado e, se não couber, o dobro — o valor certo
  // depende da versão do modelo, e adivinhar baixo custa um boot quebrado.
  size_t arenaBytes = WAKE_PREPROC_ARENA_BYTES;
  for (int attempt = 0; attempt < 2; attempt++) {
    bool psram = false;
    preprocArena = allocArena(arenaBytes, "preproc", &psram);
    if (!preprocArena) return false;

    static uint8_t interpStorage[sizeof(tflite::MicroInterpreter)];
    preprocInterp = new (interpStorage) tflite::MicroInterpreter(model, resolver, preprocArena,
                                                                 arenaBytes);
    if (preprocInterp->AllocateTensors() == kTfLiteOk) {
      Serial.printf("[wake] preprocessador ok — arena %u B (usados %u)\n", (unsigned)arenaBytes,
                    (unsigned)preprocInterp->arena_used_bytes());
      return true;
    }

    preprocInterp = nullptr;
    heap_caps_free(preprocArena);
    preprocArena = nullptr;
    arenaBytes *= 2;
  }

  Serial.println("[wake] preprocessador: AllocateTensors falhou mesmo com arena dobrada");
  return false;
}

static bool buildStreamingModel() {
  static tflite::MicroMutableOpResolver<kStreamingOps> resolver;
  resolver.AddCallOnce();
  resolver.AddVarHandle();
  resolver.AddReshape();
  resolver.AddReadVariable();
  resolver.AddStridedSlice();
  resolver.AddConcatenation();
  resolver.AddAssignVariable();
  resolver.AddConv2D();
  resolver.AddMul();
  resolver.AddAdd();
  resolver.AddMean();
  resolver.AddFullyConnected();
  resolver.AddLogistic();
  resolver.AddQuantize();
  resolver.AddDepthwiseConv2D();
  resolver.AddAveragePool2D();
  resolver.AddMaxPool2D();
  resolver.AddPad();
  resolver.AddPack();
  resolver.AddSplitV();

  const tflite::Model *model = tflite::GetModel(g_hey_luna_model_data);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    Serial.printf("[wake] modelo streaming: schema %u != %d\n", (unsigned)model->version(),
                  TFLITE_SCHEMA_VERSION);
    return false;
  }

  bool psram = false;
  variableArena = allocArena(kVariableArenaBytes, "variables", &psram);
  if (!variableArena) return false;

  tflite::MicroAllocator *varAllocator =
      tflite::MicroAllocator::Create(variableArena, kVariableArenaBytes);
  tflite::MicroResourceVariables *resourceVars =
      tflite::MicroResourceVariables::Create(varAllocator, kMaxResourceVariables);
  if (!resourceVars) {
    Serial.println("[wake] MicroResourceVariables::Create falhou");
    return false;
  }

  size_t arenaBytes = WAKE_ARENA_BYTES;
  for (int attempt = 0; attempt < 2; attempt++) {
    streamArena = allocArena(arenaBytes, "streaming", &psram);
    if (!streamArena) return false;

    static uint8_t interpStorage[sizeof(tflite::MicroInterpreter)];
    streamInterp = new (interpStorage)
        tflite::MicroInterpreter(model, resolver, streamArena, arenaBytes, resourceVars);
    if (streamInterp->AllocateTensors() == kTfLiteOk) {
      Serial.printf("[wake] modelo '%s' ok — arena %u B (usados %u)\n", WAKE_PHRASE,
                    (unsigned)arenaBytes, (unsigned)streamInterp->arena_used_bytes());
      return true;
    }

    streamInterp = nullptr;
    heap_caps_free(streamArena);
    streamArena = nullptr;
    arenaBytes *= 2;
  }

  Serial.println("[wake] modelo streaming: AllocateTensors falhou mesmo com arena dobrada");
  return false;
}

// runFeature() copia blocos de tamanho fixo para dentro dos tensores. Se um
// modelo trocado tiver outra geometria, isso vira corrupção de memória
// silenciosa — então confere tipo e tamanho antes de deixar o detector subir.
static size_t typeSize(TfLiteType t) {
  switch (t) {
  case kTfLiteInt16: return sizeof(int16_t);
  default: return sizeof(int8_t); // int8 e uint8
  }
}

static bool checkTensor(const TfLiteTensor *t, const char *what, TfLiteType type,
                        size_t elements) {
  if (!t) {
    Serial.printf("[wake] %s: tensor ausente\n", what);
    return false;
  }
  if (t->type != type) {
    Serial.printf("[wake] %s: tipo %d, esperado %d\n", what, (int)t->type, (int)type);
    return false;
  }
  const size_t expected = elements * typeSize(type);
  if (t->bytes != expected) {
    Serial.printf("[wake] %s: %u bytes, esperado %u\n", what, (unsigned)t->bytes,
                  (unsigned)expected);
    return false;
  }
  return true;
}

bool begin() {
  if (!buildPreprocessor()) return false;
  if (!buildStreamingModel()) return false;

  // A entrada do modelo streaming é [1, stride, 40]: descobre o stride pela
  // dimensão do meio, como o ESPHome faz, em vez de fixar por modelo.
  const TfLiteTensor *sIn = streamInterp->input(0);
  if (!sIn || sIn->dims->size != 3 || sIn->dims->data[0] != 1 ||
      sIn->dims->data[2] != WAKE_FEATURE_SIZE) {
    Serial.println("[wake] entrada streaming não é [1, stride, 40]");
    return false;
  }
  stride = sIn->dims->data[1];

  if (!checkTensor(preprocInterp->input(0), "preproc in", kTfLiteInt16, WAKE_WINDOW_SAMPLES) ||
      !checkTensor(preprocInterp->output(0), "preproc out", kTfLiteInt8, WAKE_FEATURE_SIZE) ||
      !checkTensor(sIn, "streaming in", kTfLiteInt8, (size_t)stride * WAKE_FEATURE_SIZE) ||
      // Saída é uint8 0..255 (probabilidade quantizada), lida crua.
      !checkTensor(streamInterp->output(0), "streaming out", kTfLiteUInt8, 1)) {
    return false;
  }

  memset(window, 0, sizeof(window));
  strideStep = 0;
  rearm();
  resetStats();

  Serial.printf("[wake] pronto — stride %d, cutoff %.2f (1 inferência a cada %dms)\n", stride,
                WAKE_PROB_CUTOFF, stride * WAKE_FEATURE_STEP_MS);
  return true;
}

// ============================================================================
// Inferência
// ============================================================================
// Chamado a cada slice de 10ms. Roda o preprocessador sempre; só invoca o modelo
// streaming quando `stride` slices já foram empilhados na entrada dele.
static void runFeature() {
  const int64_t t0 = esp_timer_get_time();
  slicesFed++;

  // --- preprocessador: 480 int16 -> 40 int8 ---
  TfLiteTensor *pIn = preprocInterp->input(0);
  memcpy(tflite::GetTensorData<int16_t>(pIn), window, sizeof(window));
  if (preprocInterp->Invoke() != kTfLiteOk) return;

  const int8_t *features = tflite::GetTensorData<int8_t>(preprocInterp->output(0));

#if WAKE_DEBUG
  for (int i = 0; i < WAKE_FEATURE_SIZE; i++) {
    if (features[i] < dbgFeatMin) dbgFeatMin = features[i];
    if (features[i] > dbgFeatMax) dbgFeatMax = features[i];
    dbgFeatSum += features[i];
  }
  dbgFeatN += WAKE_FEATURE_SIZE;
#endif

#if WAKE_DUMP_FEATURES
  memcpy(dumpRing[dumpHead], features, WAKE_FEATURE_SIZE);
  dumpHead = (dumpHead + 1) % WAKE_DUMP_SLICES;
  if (dumpHead == 0) dumpFilled = true;
#endif

  // --- empilha este slice na posição strideStep da entrada do modelo ---
  int8_t *sIn = tflite::GetTensorData<int8_t>(streamInterp->input(0));
  strideStep = strideStep % stride;
  memcpy(sIn + (size_t)WAKE_FEATURE_SIZE * strideStep, features, WAKE_FEATURE_SIZE);
  strideStep++;

  uint32_t elapsed = (uint32_t)(esp_timer_get_time() - t0);

  // Só roda a inferência quando a janela de `stride` slices fechou.
  if (strideStep < stride) {
    totalWorkUs += elapsed;
    return;
  }

  if (streamInterp->Invoke() != kTfLiteOk) return;

  // Saída uint8 0..255 -> probabilidade 0..1.
  const uint8_t raw = tflite::GetTensorData<uint8_t>(streamInterp->output(0))[0];
  const float prob = raw / 255.0f;
  lastProb = prob;
#if WAKE_DEBUG
  if (raw > dbgRawMax) dbgRawMax = raw;
#endif

  elapsed = (uint32_t)(esp_timer_get_time() - t0);
  totalWorkUs += elapsed;
  totalInferenceUs += elapsed;
  inferenceCount++;
  if (elapsed > peakInferenceUs) peakInferenceUs = elapsed;

  // --- média móvel sobre as últimas WAKE_SLIDING_WINDOW inferências ---
  recentProbs[probIndex] = prob;
  probIndex = (probIndex + 1) % WAKE_SLIDING_WINDOW;
  if (probFilled < WAKE_SLIDING_WINDOW) probFilled++;

  if (ignoreWindows > 0) {
    ignoreWindows--;
    return;
  }
  if (probFilled < WAKE_SLIDING_WINDOW) return;

  float sum = 0.0f;
  for (int i = 0; i < WAKE_SLIDING_WINDOW; i++) sum += recentProbs[i];

  if (sum > WAKE_PROB_CUTOFF * WAKE_SLIDING_WINDOW) {
    detectedFlag = true;
    ignoreWindows = WAKE_REARM_WINDOWS;
    Serial.printf("[wake] DETECTADO (média %.3f)\n", sum / WAKE_SLIDING_WINDOW);
  }
}

void feed(const int16_t *samples, size_t count) {
  if (!preprocInterp || !streamInterp) return;

#if WAKE_DEBUG
  for (size_t i = 0; i < count; i++) {
    const int16_t a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > dbgAudioPeak) dbgAudioPeak = a;
  }
#endif

  while (count > 0) {
    // Nunca engole mais que o stride de uma vez: o resto sai na volta do laço.
    const size_t take = min(count, (size_t)WAKE_STEP_SAMPLES - pendingSamples);

    // Desliza a janela para a esquerda e emenda as amostras novas no fim.
    memmove(window, window + take, (WAKE_WINDOW_SAMPLES - take) * sizeof(int16_t));
    memcpy(window + (WAKE_WINDOW_SAMPLES - take), samples, take * sizeof(int16_t));

    samples += take;
    count -= take;
    pendingSamples += take;
    if (warmupSamples < WAKE_WINDOW_SAMPLES) warmupSamples += take;

    if (pendingSamples >= (size_t)WAKE_STEP_SAMPLES) {
      pendingSamples = 0;
      if (warmupSamples >= WAKE_WINDOW_SAMPLES) runFeature();
    }
  }
}

bool takeDetection() {
  if (!detectedFlag) return false;
  detectedFlag = false;
  return true;
}

void rearm() {
  // Zera os ring buffers internos do modelo streaming (variable tensors). Sem
  // isto o modelo continua "quente" com o wake word anterior: como paramos de
  // alimentá-lo durante ACTIVE/RESPONDING, o estado congela saturado e, ao voltar
  // para IDLE, ele re-dispara sozinho (saída presa em 255) até flushar. O reset
  // devolve o detector a frio. O preprocessador não precisa: ele readapta
  // sozinho com o áudio novo.
  if (streamInterp) streamInterp->Reset();

  for (int i = 0; i < WAKE_SLIDING_WINDOW; i++) recentProbs[i] = 0.0f;
  probIndex = 0;
  probFilled = 0;
  // Cooldown de acomodação: come o eco da resposta e cobre a corrida
  // captureTask/wakeTask que deixaria o modelo ainda-quente disparar sozinho.
  ignoreWindows = WAKE_SETTLE_WINDOWS;
  strideStep = 0;
  detectedFlag = false;
  lastProb = 0.0f;
}

uint32_t avgInferenceUs() {
  return inferenceCount ? (uint32_t)(totalInferenceUs / inferenceCount) : 0;
}

uint32_t maxInferenceUs() { return peakInferenceUs; }

float cpuLoadPct() {
  if (!slicesFed) return 0.0f;
  // O preprocessador roda a cada slice (10ms) e o modelo streaming a cada
  // `stride` slices; totalWorkUs soma os dois. A base é o áudio real
  // processado (slices * 10ms), então isto é a fração de um núcleo gasta para
  // manter a escuta ligada.
  const float audioUs = (float)slicesFed * WAKE_FEATURE_STEP_MS * 1000.0f;
  return (float)totalWorkUs * 100.0f / audioUs;
}

float lastProbability() { return lastProb; }

void resetStats() {
  totalWorkUs = 0;
  totalInferenceUs = 0;
  slicesFed = 0;
  inferenceCount = 0;
  peakInferenceUs = 0;
}

void debugDumpFeatures() {
#if WAKE_DUMP_FEATURES
  static const char b64[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint32_t count = dumpFilled ? WAKE_DUMP_SLICES : dumpHead;
  const uint32_t start = dumpFilled ? dumpHead : 0; // mais antigo primeiro
  Serial.printf("[wake] FEATDUMP slices=%u feat=%d begin\n", (unsigned)count, WAKE_FEATURE_SIZE);
  // Codifica em base64 os bytes (int8 reinterpretado) em ordem cronológica.
  uint8_t trio[3];
  int fill = 0;
  char line[128];
  int lp = 0;
  for (uint32_t i = 0; i < count; i++) {
    const int8_t *slice = dumpRing[(start + i) % WAKE_DUMP_SLICES];
    for (int j = 0; j < WAKE_FEATURE_SIZE; j++) {
      trio[fill++] = (uint8_t)slice[j];
      if (fill == 3) {
        line[lp++] = b64[trio[0] >> 2];
        line[lp++] = b64[((trio[0] & 3) << 4) | (trio[1] >> 4)];
        line[lp++] = b64[((trio[1] & 15) << 2) | (trio[2] >> 6)];
        line[lp++] = b64[trio[2] & 63];
        fill = 0;
        if (lp >= 120) { line[lp] = 0; Serial.println(line); lp = 0; }
      }
    }
  }
  if (fill > 0) { // resto (padding)
    for (int k = fill; k < 3; k++) trio[k] = 0;
    line[lp++] = b64[trio[0] >> 2];
    line[lp++] = b64[((trio[0] & 3) << 4) | (trio[1] >> 4)];
    line[lp++] = fill > 1 ? b64[((trio[1] & 15) << 2) | (trio[2] >> 6)] : '=';
    line[lp++] = '=';
  }
  if (lp > 0) { line[lp] = 0; Serial.println(line); }
  Serial.println("[wake] FEATDUMP end");
#endif
}

bool debugSnapshot(char *out, size_t len) {
#if WAKE_DEBUG
  const int mean = dbgFeatN ? (int)(dbgFeatSum / (int32_t)dbgFeatN) : 0;
  snprintf(out, len, "audio_peak=%d feat[min=%d max=%d mean=%d] raw_max=%u/255",
           (int)dbgAudioPeak, (int)dbgFeatMin, (int)dbgFeatMax, mean, (unsigned)dbgRawMax);
  dbgAudioPeak = 0;
  dbgFeatMin = 127;
  dbgFeatMax = -128;
  dbgFeatSum = 0;
  dbgFeatN = 0;
  dbgRawMax = 0;
  return true;
#else
  (void)out;
  (void)len;
  return false;
#endif
}

} // namespace WakeWord
