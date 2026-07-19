import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import { normalizeToolCalls, toGeminiFunctionDeclarations } from './tool-mapping.js';
import { CONTROL_DEVICE_TOOL } from '../types.js';
import type { ToolDefinition } from '../types.js';

describe('toGeminiFunctionDeclarations', () => {
  const [declaration] = toGeminiFunctionDeclarations([CONTROL_DEVICE_TOOL]);

  it('preserva nome e descrição da tool', () => {
    assert.equal(declaration.name, 'control_device');
    assert.equal(declaration.description, CONTROL_DEVICE_TOOL.description);
  });

  it('traduz os tipos de JSON Schema para o enum Type do SDK', () => {
    assert.equal(declaration.parameters?.type, Type.OBJECT);
    assert.equal(declaration.parameters?.properties?.device?.type, Type.STRING);
  });

  it('preserva enum, description e required', () => {
    assert.deepEqual(declaration.parameters?.properties?.action?.enum, ['on', 'off']);
    assert.equal(
      declaration.parameters?.properties?.room_id?.description,
      'Área do Home Assistant onde o dispositivo está, ex: sala_de_estar',
    );
    assert.deepEqual(declaration.parameters?.required, ['device', 'action', 'room_id']);
  });

  it('lança em tipo de schema não suportado em vez de emitir declaração inválida', () => {
    const broken = {
      name: 'quebrada',
      description: 'tool com tipo inválido',
      parameters: {
        type: 'object',
        properties: { campo: { type: 'uuid' } },
      },
    } as unknown as ToolDefinition;

    assert.throws(() => toGeminiFunctionDeclarations([broken]), /não suportado/);
  });
});

describe('normalizeToolCalls', () => {
  it('mapeia id/name/args para o contrato do port', () => {
    const calls = normalizeToolCalls({
      functionCalls: [
        {
          id: 'call_1',
          name: 'control_device',
          args: { device: 'luz_bancada', action: 'on', room_id: 'sala_de_estar' },
        },
      ],
    });

    assert.deepEqual(calls, [
      {
        callId: 'call_1',
        name: 'control_device',
        args: { device: 'luz_bancada', action: 'on', room_id: 'sala_de_estar' },
      },
    ]);
  });

  it('usa objeto vazio quando args vem ausente', () => {
    const [call] = normalizeToolCalls({
      functionCalls: [{ id: 'call_1', name: 'control_device' }],
    });

    assert.deepEqual(call.args, {});
  });

  it('descarta invocações sem id ou sem name', () => {
    const calls = normalizeToolCalls({
      functionCalls: [
        { name: 'control_device' },
        { id: 'call_2' },
        { id: 'call_3', name: 'control_device' },
      ],
    });

    assert.deepEqual(
      calls.map((c) => c.callId),
      ['call_3'],
    );
  });

  it('tolera mensagem sem functionCalls', () => {
    assert.deepEqual(normalizeToolCalls({}), []);
  });
});
