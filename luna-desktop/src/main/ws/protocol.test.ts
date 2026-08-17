import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAudioMessage,
  parseControlMessage,
  parseIncomingMessage,
  serializeControlMessage,
  createEnvelope,
} from './protocol.js';

describe('buildAudioMessage / parseIncomingMessage', () => {
  it('faz round-trip de envelope + PCM', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const frame = buildAudioMessage('desktop_diogo', 42, pcm);

    const parsed = parseIncomingMessage(frame);
    assert.ok(parsed);
    assert.equal(parsed.envelope.type, 'audio_chunk');
    assert.equal(parsed.envelope.room_id, 'desktop_diogo');
    assert.equal(parsed.envelope.seq, 42);
    assert.deepEqual(parsed.pcm, pcm);
  });

  it('lida com PCM vazio (envelope sozinho)', () => {
    const frame = buildAudioMessage('sala', 1, Buffer.alloc(0));
    const parsed = parseIncomingMessage(frame);
    assert.ok(parsed);
    assert.equal(parsed.pcm.length, 0);
  });

  it('retorna null para buffer vazio', () => {
    assert.equal(parseIncomingMessage(Buffer.alloc(0)), null);
  });

  it('retorna null quando o frame não começa com "{"', () => {
    const frame = Buffer.from([0x01, 0x02, 0x03]);
    assert.equal(parseIncomingMessage(frame), null);
  });

  it('retorna null quando o JSON nunca fecha (chave sem par)', () => {
    const frame = Buffer.concat([Buffer.from('{"type":"audio_chunk"', 'utf8')]);
    assert.equal(parseIncomingMessage(frame), null);
  });

  it('acha o fim do JSON por profundidade de chaves, mesmo com PCM colado logo em seguida', () => {
    const envelope = createEnvelope('audio_response', 'sala', { seq: 7 });
    const header = Buffer.from(serializeControlMessage(envelope), 'utf8');
    const pcm = Buffer.from([0xff, 0x00, 0xab, 0xcd]);
    const frame = Buffer.concat([header, pcm]);

    const parsed = parseIncomingMessage(frame);
    assert.ok(parsed);
    assert.equal(parsed.envelope.type, 'audio_response');
    assert.deepEqual(parsed.pcm, pcm);
  });
});

describe('parseControlMessage', () => {
  it('rejeita JSON sem type ou sem room_id (guard do servidor)', () => {
    assert.equal(parseControlMessage('{"room_id":"sala"}'), null);
    assert.equal(parseControlMessage('{"type":"ping"}'), null);
    assert.equal(parseControlMessage('not json'), null);
  });

  it('aceita um envelope de controle válido', () => {
    const parsed = parseControlMessage('{"type":"speaking_start","room_id":"sala"}');
    assert.ok(parsed);
    assert.equal(parsed.type, 'speaking_start');
  });
});
