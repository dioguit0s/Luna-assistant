import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_DEVICES_TOOL, isListDevicesArgs } from './tools.js';

describe('isListDevicesArgs', () => {
  it('aceita room_id string, incluindo vazia', () => {
    assert.ok(isListDevicesArgs({ room_id: 'cozinha' }));
    assert.ok(isListDevicesArgs({ room_id: '' }));
  });

  it('aceita room_id ausente — o handler resolve pelo cômodo da sessão', () => {
    assert.ok(isListDevicesArgs({}));
  });

  it('rejeita número, null, objeto e array', () => {
    assert.equal(isListDevicesArgs({ room_id: 7 }), false);
    assert.equal(isListDevicesArgs({ room_id: null }), false);
    assert.equal(isListDevicesArgs({ room_id: {} }), false);
    assert.equal(isListDevicesArgs({ room_id: ['cozinha'] }), false);
  });
});

describe('LIST_DEVICES_TOOL', () => {
  it('schema é plano — sem array, sem objeto aninhado (limite do tool-mapping do Gemini)', () => {
    for (const [name, prop] of Object.entries(LIST_DEVICES_TOOL.parameters.properties)) {
      const schema = prop as { type: string };
      assert.notEqual(schema.type, 'array', `${name} não pode ser array`);
      assert.notEqual(schema.type, 'object', `${name} não pode ser objeto`);
    }
  });

  it('room_id é string e não é obrigatório', () => {
    const roomId = LIST_DEVICES_TOOL.parameters.properties.room_id as { type: string };
    assert.equal(roomId.type, 'string');
    assert.deepEqual(LIST_DEVICES_TOOL.parameters.required, []);
  });
});
