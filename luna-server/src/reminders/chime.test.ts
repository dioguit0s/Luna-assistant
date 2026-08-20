import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHIME_PCM16 } from './chime.js';

const SAMPLE_RATE_HZ = 16_000;

describe('chime', () => {
  it('é PCM16 mono: número par de bytes, tamanho múltiplo de uma amostra', () => {
    assert.equal(CHIME_PCM16.length % 2, 0);
    assert.ok(CHIME_PCM16.length > 0);
  });

  it('não estoura int16 (amplitude moderada, não fundo de escala)', () => {
    // 8000, não 32767: full-scale sai duro no MAX98357A do satélite.
    let max = 0;
    for (let i = 0; i < CHIME_PCM16.length; i += 2) {
      max = Math.max(max, Math.abs(CHIME_PCM16.readInt16LE(i)));
    }
    assert.ok(max <= 8_000, `pico ${max} acima da amplitude esperada`);
    assert.ok(max > 7_000, `pico ${max} suspeitosamente baixo — rampa comendo o tom inteiro?`);
  });

  it('começa e termina em silêncio (rampa nas duas pontas, sem clique)', () => {
    const primeiraAmostra = CHIME_PCM16.readInt16LE(0);
    const ultimaAmostra = CHIME_PCM16.readInt16LE(CHIME_PCM16.length - 2);

    assert.equal(primeiraAmostra, 0);
    // A última amostra da rampa linear pode não cair exatamente em zero
    // (depende de onde o passo do seno cai), mas precisa estar longe do pico.
    assert.ok(Math.abs(ultimaAmostra) < 1_000, `borda final ainda alta: ${ultimaAmostra}`);
  });

  it('bate com a fórmula documentada — seno com envelope linear, ponto a ponto', () => {
    // Trata o buffer como caixa-preta e recomputa a referência a partir dos
    // mesmos parâmetros documentados (amplitude 8000, ~5ms de rampa, 1200Hz a
    // 16kHz) — não só olha algumas propriedades soltas, confere a amostra.
    const freqHz = 1_200;
    const amplitude = 8_000;
    const durationMs = 1_000;
    const totalSamples = Math.floor((SAMPLE_RATE_HZ * durationMs) / 1000);
    const rampSamples = Math.min(
      Math.floor(SAMPLE_RATE_HZ / 200),
      Math.floor(totalSamples / 2),
    );
    const step = (2 * Math.PI * freqHz) / SAMPLE_RATE_HZ;

    assert.equal(CHIME_PCM16.length, totalSamples * 2, 'duração não bate com o documentado');

    let phase = 0;
    for (let i = 0; i < totalSamples; i++) {
      let envelope = 1;
      if (i < rampSamples) envelope = i / rampSamples;
      else if (i >= totalSamples - rampSamples) envelope = (totalSamples - i) / rampSamples;

      const esperado = Math.round(Math.sin(phase) * amplitude * envelope);
      const real = CHIME_PCM16.readInt16LE(i * 2);

      // Tolerância de 1 LSB: a fase acumulada em ponto flutuante pode divergir
      // por arredondamento de casa decimal entre esta reconstrução e a
      // original, mesmo com a mesma fórmula.
      assert.ok(
        Math.abs(real - esperado) <= 1,
        `amostra ${i}: esperado ~${esperado}, veio ${real}`,
      );

      phase += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  });

});
