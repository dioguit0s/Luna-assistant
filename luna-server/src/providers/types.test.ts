import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_DEVICE_TOOL, isControlDeviceCall } from './types.js';
import type { ToolCall } from './types.js';

function call(args: Record<string, unknown>, name = 'control_device'): ToolCall {
  return { callId: 'call_1', name, args };
}

const validArgs = { device: 'luz_bancada', action: 'on', room_id: 'sala_de_estar' };

describe('CONTROL_DEVICE_TOOL', () => {
  it('declara os três parâmetros como obrigatórios', () => {
    assert.deepEqual(CONTROL_DEVICE_TOOL.parameters.required, ['device', 'action', 'room_id']);
  });
});

describe('isControlDeviceCall', () => {
  it('aceita payload completo com action on', () => {
    assert.equal(isControlDeviceCall(call(validArgs)), true);
  });

  it('aceita action off', () => {
    assert.equal(isControlDeviceCall(call({ ...validArgs, action: 'off' })), true);
  });

  it('rejeita tool com outro nome', () => {
    assert.equal(isControlDeviceCall(call(validArgs, 'get_weather')), false);
  });

  it('rejeita action fora do enum', () => {
    assert.equal(isControlDeviceCall(call({ ...validArgs, action: 'toggle' })), false);
  });

  it('rejeita room_id ausente', () => {
    assert.equal(isControlDeviceCall(call({ device: 'luz_bancada', action: 'on' })), false);
  });

  it('rejeita device vazio', () => {
    assert.equal(isControlDeviceCall(call({ ...validArgs, device: '' })), false);
  });

  it('rejeita device de tipo errado', () => {
    assert.equal(isControlDeviceCall(call({ ...validArgs, device: 42 })), false);
  });
});
