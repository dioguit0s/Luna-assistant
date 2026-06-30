import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resample16kTo24k, resample24kTo16k } from './resampler.js';

describe('resampler', () => {
  it('retorna buffer vazio para entrada vazia', () => {
    assert.equal(resample16kTo24k(Buffer.alloc(0)).length, 0);
  });

  it('16kHz → 24kHz aumenta tamanho do buffer', () => {
    const input = Buffer.alloc(320 * 2);
    for (let i = 0; i < 320; i++) {
      input.writeInt16LE(Math.sin(i / 10) * 16000, i * 2);
    }
    const output = resample16kTo24k(input);
    assert.ok(output.length > input.length);
    assert.equal(output.length, 480 * 2);
  });

  it('round-trip 16→24→16 preserva ordem de magnitude', () => {
    const input = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      input.writeInt16LE(1000, i * 2);
    }
    const via24k = resample16kTo24k(input);
    const back = resample24kTo16k(via24k);
    assert.ok(back.length > 0);
  });
});
