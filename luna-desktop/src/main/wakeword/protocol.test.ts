import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseWakewordLine } from './protocol.js';

describe('parseWakewordLine', () => {
  it('parseia o evento ready', () => {
    const line = JSON.stringify({
      event: 'ready',
      model: 'hey_luna_trained.tflite',
      model_sha256: 'abc123',
      stride: 3,
      threshold: 0.97,
      input_scale: 0.10196078568696976,
      input_zero_point: -128,
    });
    const parsed = parseWakewordLine(line);
    assert.ok(parsed);
    assert.equal(parsed.event, 'ready');
    assert.equal(parsed.event === 'ready' && parsed.model, 'hey_luna_trained.tflite');
  });

  it('parseia o evento wake', () => {
    const line = JSON.stringify({ event: 'wake', audio_ms: 4320.0, prob: 0.9843, mean_prob: 0.9781, inference: 216 });
    const parsed = parseWakewordLine(line);
    assert.ok(parsed);
    assert.equal(parsed.event, 'wake');
    assert.equal(parsed.event === 'wake' && parsed.mean_prob, 0.9781);
  });

  it('parseia o evento eof', () => {
    const line = JSON.stringify({ event: 'eof', audio_ms: 60000.0, inferences: 3000 });
    const parsed = parseWakewordLine(line);
    assert.ok(parsed);
    assert.equal(parsed.event, 'eof');
  });

  it('parseia o evento error', () => {
    const line = JSON.stringify({ event: 'error', message: 'modelo não encontrado' });
    const parsed = parseWakewordLine(line);
    assert.ok(parsed);
    assert.equal(parsed.event, 'error');
    assert.equal(parsed.event === 'error' && parsed.message, 'modelo não encontrado');
  });

  it('parseia error igual estando na primeira linha (parser é stateless)', () => {
    // O sidecar pode nunca emitir `ready` se o modelo estiver ausente — a
    // primeira (e única) linha recebida pode ser um `error`.
    const parsed = parseWakewordLine(JSON.stringify({ event: 'error', message: 'geometria inválida' }));
    assert.ok(parsed);
    assert.equal(parsed.event, 'error');
  });

  it('retorna null para linha vazia ou só espaços', () => {
    assert.equal(parseWakewordLine(''), null);
    assert.equal(parseWakewordLine('   \n'), null);
  });

  it('retorna null para JSON malformado', () => {
    assert.equal(parseWakewordLine('{not json'), null);
  });

  it('retorna null para JSON válido sem campo event', () => {
    assert.equal(parseWakewordLine(JSON.stringify({ foo: 'bar' })), null);
  });

  it('retorna null para evento desconhecido', () => {
    assert.equal(parseWakewordLine(JSON.stringify({ event: 'heartbeat' })), null);
  });

  it('retorna null para um array ou primitivo JSON válido', () => {
    assert.equal(parseWakewordLine('[1,2,3]'), null);
    assert.equal(parseWakewordLine('42'), null);
    assert.equal(parseWakewordLine('null'), null);
  });
});
