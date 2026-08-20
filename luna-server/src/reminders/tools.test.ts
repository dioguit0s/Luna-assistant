import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SET_REMINDER_TOOL, isSetReminderArgs } from './tools.js';

describe('isSetReminderArgs', () => {
  it('aceita args vazios (label ausente, sem in_seconds/at_time — a exclusividade é do resolveOnce)', () => {
    assert.equal(isSetReminderArgs({}), true);
  });

  it('aceita a forma completa', () => {
    assert.equal(
      isSetReminderArgs({ label: 'tomar remédio', at_time: '07:00', when_day: 'tomorrow' }),
      true,
    );
  });

  it('rejeita label que não é string', () => {
    assert.equal(isSetReminderArgs({ label: 123 }), false);
  });

  it('rejeita in_seconds que não é number', () => {
    assert.equal(isSetReminderArgs({ in_seconds: '600' }), false);
  });

  it('rejeita at_time que não é string', () => {
    assert.equal(isSetReminderArgs({ at_time: 700 }), false);
  });

  it('rejeita when_day fora do enum', () => {
    assert.equal(isSetReminderArgs({ when_day: 'segunda-feira' }), false);
  });
});

describe('SET_REMINDER_TOOL', () => {
  it('schema é plano — sem array, sem objeto aninhado (limite do tool-mapping do Gemini)', () => {
    for (const [name, prop] of Object.entries(SET_REMINDER_TOOL.parameters.properties)) {
      const schema = prop as { type: string };
      assert.notEqual(schema.type, 'array', `${name} não pode ser array`);
      assert.notEqual(schema.type, 'object', `${name} não pode ser objeto`);
    }
  });

  it('when_day tem enum explícito', () => {
    const whenDay = SET_REMINDER_TOOL.parameters.properties.when_day as { enum?: string[] };
    assert.deepEqual(whenDay.enum, [
      'today',
      'tomorrow',
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
    ]);
  });
});
