import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioMessage } from './messageParser.js';

function buildFrame(headerObj: Record<string, unknown>, pcm: Buffer): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  return Buffer.concat([headerBuf, pcm]);
}

describe('parseAudioMessage', () => {
  it('separa header e PCM no caso normal', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const frame = buildFrame({ type: 'audio_chunk', room_id: 'sala_de_estar' }, pcm);

    const parsed = parseAudioMessage(frame);

    assert.ok(parsed);
    assert.equal(parsed!.envelope.type, 'audio_chunk');
    assert.deepEqual(parsed!.pcm, pcm);
  });

  it('chave/valor com "{" ou "}" dentro de uma string não corta o header cedo demais', () => {
    // device_id malicioso/malformado com chaves literais no valor — a
    // contagem de profundidade ingênua (sem consciência de string) fecharia
    // o header no primeiro "}" da própria string, cortando o PCM no lugar
    // errado.
    const pcm = Buffer.from([9, 9, 9, 9, 9]);
    const frame = buildFrame(
      { type: 'audio_chunk', room_id: 'sala_de_estar', device_id: '{fake}' },
      pcm,
    );

    const parsed = parseAudioMessage(frame);

    assert.ok(parsed);
    assert.equal(parsed!.envelope.device_id, '{fake}');
    assert.deepEqual(parsed!.pcm, pcm);
  });

  it('aspas escapadas dentro de uma string não derrubam a contagem de profundidade', () => {
    const pcm = Buffer.from([7, 7, 7]);
    const frame = buildFrame(
      { type: 'audio_chunk', room_id: 'sala_de_estar', device_id: 'com "aspas" e \\ barra' },
      pcm,
    );

    const parsed = parseAudioMessage(frame);

    assert.ok(parsed);
    assert.equal(parsed!.envelope.device_id, 'com "aspas" e \\ barra');
    assert.deepEqual(parsed!.pcm, pcm);
  });

  it('sem "}" de fechamento retorna null', () => {
    const broken = Buffer.from('{"type":"audio_chunk","room_id":"sala"', 'utf8');
    assert.equal(parseAudioMessage(broken), null);
  });

  it('tipo diferente de audio_chunk retorna null', () => {
    const frame = buildFrame({ type: 'ping', room_id: 'sala_de_estar' }, Buffer.from([1]));
    assert.equal(parseAudioMessage(frame), null);
  });

  it('buffer vazio ou que não começa com "{" retorna null', () => {
    assert.equal(parseAudioMessage(Buffer.alloc(0)), null);
    assert.equal(parseAudioMessage(Buffer.from([0x01, 0x02])), null);
  });
});
