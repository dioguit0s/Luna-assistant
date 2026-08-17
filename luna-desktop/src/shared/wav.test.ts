import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { patchWavHeaderSizes, wavHeaderPcm16, WAV_HEADER_BYTES } from './wav.js';

describe('wavHeaderPcm16', () => {
  it('monta um header RIFF/WAVE PCM16 mono de 44 bytes', () => {
    const header = wavHeaderPcm16(64000, 16000);
    assert.equal(header.length, WAV_HEADER_BYTES);
    assert.equal(header.toString('ascii', 0, 4), 'RIFF');
    assert.equal(header.toString('ascii', 8, 12), 'WAVE');
    assert.equal(header.toString('ascii', 12, 16), 'fmt ');
    assert.equal(header.toString('ascii', 36, 40), 'data');

    assert.equal(header.readUInt32LE(4), 36 + 64000); // fileSize
    assert.equal(header.readUInt16LE(20), 1); // PCM
    assert.equal(header.readUInt16LE(22), 1); // mono
    assert.equal(header.readUInt32LE(24), 16000); // sampleRate
    assert.equal(header.readUInt32LE(28), 32000); // byteRate
    assert.equal(header.readUInt16LE(32), 2); // blockAlign
    assert.equal(header.readUInt16LE(34), 16); // bitsPerSample
    assert.equal(header.readUInt32LE(40), 64000); // dataSize
  });

  it('aceita dataSize=0 como placeholder', () => {
    const header = wavHeaderPcm16(0);
    assert.equal(header.readUInt32LE(4), 36);
    assert.equal(header.readUInt32LE(40), 0);
  });
});

describe('patchWavHeaderSizes', () => {
  it('corrige só os dois campos de tamanho, preservando o resto do header', () => {
    const header = wavHeaderPcm16(0, 16000);
    patchWavHeaderSizes(header, 12345);
    assert.equal(header.readUInt32LE(4), 36 + 12345);
    assert.equal(header.readUInt32LE(40), 12345);
    // o resto do header não muda
    assert.equal(header.readUInt32LE(24), 16000);
    assert.equal(header.readUInt16LE(34), 16);
  });
});
