import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SET_REMINDER_TOOL,
  isSetReminderArgs,
  MANAGE_REMINDERS_TOOL,
  isManageRemindersArgs,
} from './tools.js';

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

describe('isManageRemindersArgs', () => {
  it('aceita as duas ações do marco 7, com e sem minutes', () => {
    assert.equal(isManageRemindersArgs({ action: 'dismiss' }), true);
    assert.equal(isManageRemindersArgs({ action: 'snooze' }), true);
    assert.equal(isManageRemindersArgs({ action: 'snooze', minutes: 5 }), true);
  });

  it('aceita os filtros de cancelamento', () => {
    assert.equal(isManageRemindersArgs({ action: 'list' }), true);
    assert.equal(isManageRemindersArgs({ action: 'cancel', at_time: '07:00' }), true);
    assert.equal(isManageRemindersArgs({ action: 'cancel', label: 'remédio' }), true);
    assert.equal(isManageRemindersArgs({ action: 'cancel', reminder_id: 'A7K3' }), true);
  });

  it('rejeita ação ausente, fora do enum, ou campo com tipo errado', () => {
    assert.equal(isManageRemindersArgs({}), false);
    assert.equal(isManageRemindersArgs({ action: 'reschedule' }), false);
    assert.equal(isManageRemindersArgs({ action: 'snooze', minutes: '5' }), false);
    assert.equal(isManageRemindersArgs({ action: 'cancel', at_time: 7 }), false);
    assert.equal(isManageRemindersArgs({ action: 'cancel', label: ['remédio'] }), false);
  });
});

describe('MANAGE_REMINDERS_TOOL', () => {
  it('schema é plano, com action em enum explícito e obrigatório', () => {
    for (const [name, prop] of Object.entries(MANAGE_REMINDERS_TOOL.parameters.properties)) {
      const schema = prop as { type: string };
      assert.notEqual(schema.type, 'array', `${name} não pode ser array`);
      assert.notEqual(schema.type, 'object', `${name} não pode ser objeto`);
    }

    const action = MANAGE_REMINDERS_TOOL.parameters.properties.action as { enum?: string[] };
    assert.deepEqual(action.enum, ['dismiss', 'snooze', 'list', 'cancel']);
    assert.deepEqual(MANAGE_REMINDERS_TOOL.parameters.required, ['action']);
  });
});

describe('SET_REMINDER_TOOL: campo repeat', () => {
  it('repeat tem enum explícito, com none incluso', () => {
    const repeat = SET_REMINDER_TOOL.parameters.properties.repeat as { enum?: string[] };
    assert.deepEqual(repeat.enum, ['none', 'daily', 'weekdays', 'weekend', 'weekly']);
  });

  it('o guard rejeita repeat fora do enum em vez de descartá-lo em silêncio', () => {
    assert.equal(isSetReminderArgs({ at_time: '07:00', repeat: 'daily' }), true);
    assert.equal(isSetReminderArgs({ at_time: '07:00', repeat: 'monthly' }), false);
    assert.equal(isSetReminderArgs({ at_time: '07:00', repeat: 7 }), false);
  });
});
