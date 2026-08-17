import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_SAMPLES, float32ToInt16, sliceIntoChunks } from './pcm.js';

describe('float32ToInt16', () => {
  it('converte a faixa completa sem estourar', () => {
    const out = float32ToInt16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    assert.deepEqual(Array.from(out), [0, 0x7fff, -0x8000, 16383, -16384]);
  });

  it('grampeia valores fora de [-1, 1] em vez de dar wrap-around', () => {
    const out = float32ToInt16(new Float32Array([2.5, -3.7]));
    assert.deepEqual(Array.from(out), [0x7fff, -0x8000]);
  });
});

describe('sliceIntoChunks', () => {
  it('divide em blocos exatos de CHUNK_SAMPLES', () => {
    const samples = new Int16Array(CHUNK_SAMPLES * 2).fill(7);
    const chunks = sliceIntoChunks(samples);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, CHUNK_SAMPLES);
    assert.equal(chunks[1].length, CHUNK_SAMPLES);
  });

  it('preenche o último bloco parcial com zero em vez de descartar', () => {
    const samples = new Int16Array(CHUNK_SAMPLES + 10).fill(9);
    const chunks = sliceIntoChunks(samples);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1][9], 9);
    assert.equal(chunks[1][10], 0);
    assert.equal(chunks[1].length, CHUNK_SAMPLES);
  });
});
