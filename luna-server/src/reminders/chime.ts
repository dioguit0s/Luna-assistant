/**
 * Gerador do bipe de alarme: PCM16 mono a 16 kHz, gerado uma vez no load do
 * módulo — nunca por disparo, é sempre a mesma forma de onda.
 *
 * Replica as duas propriedades de `AudioPlayback::renderTone`
 * (`luna-firmware/src/audio/AudioPlayback.cpp:88-108`), não por capricho: são
 * as duas coisas que fazem o tom soar bem no MAX98357A do satélite.
 * `luna-firmware/src/audio/AudioPlayback.cpp` e este módulo são duas
 * implementações do mesmo algoritmo — mudar a fórmula aqui sem revisar lá (ou
 * vice-versa) é a mesma classe de regressão silenciosa do contrato WS (ver
 * CLAUDE.md).
 */

/** Mesma taxa do áudio de resposta (AUDIO_RESPONSE_SAMPLE_RATE_HZ em Orchestrator.ts) e do firmware (config.h SAMPLE_RATE). */
export const SAMPLE_RATE_HZ = 16_000;

/**
 * 1200 Hz: o mesmo tom do chirp local de wake word do firmware
 * (`WAKE_CHIRP_FREQ_HZ`, `config.h`). Reusar a frequência não é acidente — é
 * a mesma que o plano já argumenta ser segura contra o detector de wake word
 * ("um tom puro de 1200 Hz não parece fala para o modelo").
 */
const CHIME_FREQ_HZ = 1_200;

/** Duração de um bipe. A cadência da rajada inteira (silêncio entre rajadas) é a janela de escuta do `AlarmRinger` — este número é só a duração de UM tom. */
export const CHIME_DURATION_MS = 1_000;

/**
 * Amplitude moderada, não fundo de escala: full-scale (32767) sai duro no
 * MAX98357A do satélite. Mesmo valor do firmware.
 */
const AMPLITUDE = 8_000;

/**
 * Rampa linear nas duas pontas, ~5 ms (SAMPLE_RATE/200 amostras — 80 amostras
 * a 16 kHz). Sem ela, um seno que começa e termina no seco vira um clique
 * audível.
 */
const RAMP_SAMPLES = Math.min(
  Math.floor(SAMPLE_RATE_HZ / 200),
  Math.floor((SAMPLE_RATE_HZ * CHIME_DURATION_MS) / 1000 / 2),
);

function renderChime(): Buffer {
  const totalSamples = Math.floor((SAMPLE_RATE_HZ * CHIME_DURATION_MS) / 1000);
  const step = (2 * Math.PI * CHIME_FREQ_HZ) / SAMPLE_RATE_HZ;
  const pcm = Buffer.alloc(totalSamples * 2); // PCM16 = 2 bytes/amostra

  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    let envelope = 1;
    if (RAMP_SAMPLES > 0) {
      if (i < RAMP_SAMPLES) envelope = i / RAMP_SAMPLES;
      else if (i >= totalSamples - RAMP_SAMPLES) envelope = (totalSamples - i) / RAMP_SAMPLES;
    }

    const sample = Math.round(Math.sin(phase) * AMPLITUDE * envelope);
    pcm.writeInt16LE(sample, i * 2);

    phase += step;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }

  return pcm;
}

/** PCM16 mono 16kHz do bipe de alarme. Gerado uma vez, reusado em todo `ringOnce`. */
export const CHIME_PCM16: Buffer = renderChime();
