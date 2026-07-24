import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFunctionCallItem, toOpenAIFunctionTools } from './tool-mapping.js';
import { CONTROL_DEVICE_TOOL, isControlDeviceCall } from '../types.js';

describe('toOpenAIFunctionTools', () => {
  const [tool] = toOpenAIFunctionTools([CONTROL_DEVICE_TOOL]);

  it('declara a tool como function com os campos na raiz', () => {
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'control_device');
    assert.equal(tool.description, CONTROL_DEVICE_TOOL.description);
  });

  it('repassa o JSON Schema sem tradução de tipos', () => {
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.properties.action, {
      type: 'string',
      enum: ['on', 'off'],
      description: 'Estado desejado do dispositivo',
    });
    assert.deepEqual(tool.parameters.required, ['device', 'action', 'room_id']);
  });
});

describe('normalizeFunctionCallItem', () => {
  it('desserializa arguments para o contrato do port', () => {
    const call = normalizeFunctionCallItem({
      type: 'function_call',
      call_id: 'call_1',
      name: 'control_device',
      arguments: '{"device":"luz_bancada","action":"on","room_id":"sala_de_estar"}',
    });

    assert.deepEqual(call, {
      callId: 'call_1',
      name: 'control_device',
      args: { device: 'luz_bancada', action: 'on', room_id: 'sala_de_estar' },
    });
  });

  it('produz uma call que o type guard de control_device aceita', () => {
    const call = normalizeFunctionCallItem({
      call_id: 'call_1',
      name: 'control_device',
      arguments: '{"device":"luz","action":"off","room_id":"cozinha"}',
    });

    assert.ok(call);
    assert.ok(isControlDeviceCall(call));
  });

  it('usa objeto vazio quando arguments vem ausente', () => {
    const call = normalizeFunctionCallItem({ call_id: 'call_1', name: 'control_device' });
    assert.deepEqual(call?.args, {});
  });

  it('descarta item sem call_id ou sem name', () => {
    assert.equal(normalizeFunctionCallItem({ name: 'control_device' }), null);
    assert.equal(normalizeFunctionCallItem({ call_id: 'call_1' }), null);
  });

  it('devolve null em arguments com JSON inválido em vez de lançar', () => {
    assert.equal(
      normalizeFunctionCallItem({
        call_id: 'call_1',
        name: 'control_device',
        arguments: '{"device":',
      }),
      null,
    );
  });

  it('reduz arguments não-objeto a {}, deixando o type guard reprovar', () => {
    const call = normalizeFunctionCallItem({
      call_id: 'call_1',
      name: 'control_device',
      arguments: '["luz_bancada"]',
    });

    assert.deepEqual(call?.args, {});
    assert.ok(call);
    assert.equal(isControlDeviceCall(call), false);
  });
});
