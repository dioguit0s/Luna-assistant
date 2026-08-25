import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spokenInstant, spokenWhenFor, spokenReminder } from './spoken.js';
import type { Reminder } from './ReminderStore.js';

/** 2026-08-20 é quinta. 12:00 UTC = 09:00 em São Paulo. */
const QUINTA_09H = Date.UTC(2026, 7, 20, 12, 0, 0);
const AGORA = new Date(QUINTA_09H);
const HORA = 3_600_000;
const DIA = 24 * HORA;

const base: Reminder = {
  id: 1,
  shortId: 'A7K3',
  roomId: 'sala_de_estar',
  label: null,
  kind: 'once',
  dueAtUtc: QUINTA_09H + 2 * HORA,
  localHour: null,
  localMinute: null,
  repeatRule: null,
  nextDueUtc: QUINTA_09H + 2 * HORA,
  status: 'armed',
  createdAt: QUINTA_09H,
  updatedAt: QUINTA_09H,
  lastFiredAt: null,
  fireCount: 0,
};

describe('spokenInstant', () => {
  it('hoje, amanhã e o dia da semana dentro da mesma semana', () => {
    assert.equal(spokenInstant(QUINTA_09H + 11 * HORA, AGORA), 'hoje às 20:00');
    assert.equal(spokenInstant(QUINTA_09H + DIA - 2.5 * HORA, AGORA), 'amanhã às 06:30');
    assert.equal(spokenInstant(QUINTA_09H + 3 * DIA, AGORA), 'domingo às 09:00');
  });

  it('além da semana vira data falada, não "sexta" de novo', () => {
    // Sem isso, "sexta às 20:00" seria dito tanto para amanhã quanto para a
    // sexta da semana seguinte.
    assert.equal(spokenInstant(QUINTA_09H + 9 * DIA, AGORA), 'dia 29 de agosto às 09:00');
  });

  it('vira o dia às 00:xx conta como amanhã, não como hoje', () => {
    // Meia-noite e dez é "amanhã" para quem está acordado às nove da manhã: a
    // diferença é de dias de calendário, não de horas corridas.
    assert.equal(spokenInstant(QUINTA_09H + 15 * HORA + 10 * 60_000, AGORA), 'amanhã às 00:10');
  });
});

describe('spokenWhenFor', () => {
  it('one-shot fala o instante', () => {
    assert.equal(spokenWhenFor(base, AGORA), 'hoje às 11:00');
  });

  it('recorrente fala a regra, nunca a próxima ocorrência', () => {
    const recorrente: Reminder = {
      ...base,
      kind: 'recurring',
      dueAtUtc: null,
      localHour: 6,
      localMinute: 30,
      repeatRule: 'weekdays',
      nextDueUtc: QUINTA_09H + DIA,
    };

    assert.equal(spokenWhenFor(recorrente, AGORA), 'todo dia útil às 06:30');
  });
});

describe('spokenReminder', () => {
  it('junta o texto ao horário, e omite o texto quando não há', () => {
    assert.equal(spokenReminder({ ...base, label: 'remédio' }, AGORA), 'remédio, hoje às 11:00');
    assert.equal(spokenReminder(base, AGORA), 'hoje às 11:00');
  });
});
