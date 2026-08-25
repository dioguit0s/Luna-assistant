import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GET_WEATHER_TOOL, isGetWeatherArgs } from './tools.js';

describe('isGetWeatherArgs', () => {
  it('aceita os três valores de when', () => {
    assert.ok(isGetWeatherArgs({ when: 'now' }));
    assert.ok(isGetWeatherArgs({ when: 'today' }));
    assert.ok(isGetWeatherArgs({ when: 'tomorrow' }));
  });

  it('aceita when ausente — o handler resolve como now', () => {
    assert.ok(isGetWeatherArgs({}));
  });

  it('rejeita valor fora do enum, número, e objeto', () => {
    assert.equal(isGetWeatherArgs({ when: 'ontem' }), false);
    assert.equal(isGetWeatherArgs({ when: 7 }), false);
    assert.equal(isGetWeatherArgs({ when: null }), false);
    assert.equal(isGetWeatherArgs({ when: {} }), false);
  });
});

describe('GET_WEATHER_TOOL', () => {
  it('schema é plano — sem array, sem objeto aninhado (limite do tool-mapping do Gemini)', () => {
    for (const [name, prop] of Object.entries(GET_WEATHER_TOOL.parameters.properties)) {
      const schema = prop as { type: string };
      assert.notEqual(schema.type, 'array', `${name} não pode ser array`);
      assert.notEqual(schema.type, 'object', `${name} não pode ser objeto`);
    }
  });

  it('when tem enum explícito e não é obrigatório', () => {
    const when = GET_WEATHER_TOOL.parameters.properties.when as { enum?: string[] };
    assert.deepEqual(when.enum, ['now', 'today', 'tomorrow']);
    assert.deepEqual(GET_WEATHER_TOOL.parameters.required, []);
  });
});
