// Constantes de áudio compartilhadas entre main e renderer, e a conversão
// float32→int16 usada tanto no worklet de captura quanto nos testes.
//
// Módulo puro (sem Node, sem DOM): pode ser importado do processo principal
// (via tsc→CJS/ESM normal) e — se algum dia o `addModule` do worklet aceitar
// import — do próprio AudioWorkletProcessor, que roda num realm isolado sem
// `require`/`fetch` completos. Ver risco documentado no plano do marco 2.

/** Mesma cadência do firmware (config.h) e do luna-client-test: 16 kHz mono. */
export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BIT_DEPTH = 16;

/** 320 amostras = 20 ms @ 16 kHz — o quantum de frame do protocolo. */
export const CHUNK_SAMPLES = 320;
export const CHUNK_BYTES = CHUNK_SAMPLES * 2;

/**
 * Converte um bloco de amostras float32 em [-1, 1] (formato nativo do Web
 * Audio) para PCM16LE. Amostras fora da faixa são grampeadas — sem isso, um
 * ganho > 1.0 (ex.: autoGainControl agressivo) faz o Int16Array dar wrap-around
 * em vez de saturar, o que soa como estalos digitais em vez de simples clipping.
 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * Fatia um Int16Array em blocos de exatamente `CHUNK_SAMPLES` amostras
 * (640 bytes), como o firmware e o luna-client-test streamam. O último bloco,
 * se parcial, é preenchido com zero — nunca descartado, para não perder o
 * fim de uma frase por estar a poucas amostras de um chunk completo.
 */
export function sliceIntoChunks(samples: Int16Array): Int16Array[] {
  const chunks: Int16Array[] = [];
  for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
    const slice = samples.subarray(offset, offset + CHUNK_SAMPLES);
    if (slice.length === CHUNK_SAMPLES) {
      chunks.push(slice);
    } else {
      const padded = new Int16Array(CHUNK_SAMPLES);
      padded.set(slice);
      chunks.push(padded);
    }
  }
  return chunks;
}
