import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeIso, resolveDay, resolveRange, spokenDate, splitIso } from './dates.js';

/** Sexta-feira, 25 de setembro de 2026, 10:00 em São Paulo. */
const NOW = new Date('2026-09-25T13:00:00Z');

describe('resolveDay', () => {
  it('today, tomorrow e dia da semana (hoje conta)', () => {
    assert.deepEqual(resolveDay({ day: 'today' }, NOW), { ok: true, date: '2026-09-25' });
    assert.deepEqual(resolveDay({ day: 'tomorrow' }, NOW), { ok: true, date: '2026-09-26' });
    assert.deepEqual(resolveDay({ day: 'fri' }, NOW), { ok: true, date: '2026-09-25' });
    assert.deepEqual(resolveDay({ day: 'mon' }, NOW), { ok: true, date: '2026-09-28' });
    assert.deepEqual(resolveDay({ day: 'thu' }, NOW), { ok: true, date: '2026-10-01' });
  });

  it('ausente é hoje', () => {
    assert.deepEqual(resolveDay({}, NOW), { ok: true, date: '2026-09-25' });
  });

  it('dia do mês: o próximo com esse número, pulando mês que não tem', () => {
    assert.deepEqual(resolveDay({ dayOfMonth: 30 }, NOW), { ok: true, date: '2026-09-30' });
    assert.deepEqual(resolveDay({ dayOfMonth: 25 }, NOW), { ok: true, date: '2026-09-25' });
    assert.deepEqual(resolveDay({ dayOfMonth: 2 }, NOW), { ok: true, date: '2026-10-02' });
    // Setembro não tem 31: o próximo é 31 de outubro.
    assert.deepEqual(resolveDay({ dayOfMonth: 31 }, NOW), { ok: true, date: '2026-10-31' });
  });

  it('recusa dia inexistente e os dois jeitos juntos', () => {
    assert.equal(resolveDay({ dayOfMonth: 0 }, NOW).ok, false);
    assert.equal(resolveDay({ dayOfMonth: 32 }, NOW).ok, false);
    assert.equal(resolveDay({ dayOfMonth: 2.5 }, NOW).ok, false);
    assert.equal(resolveDay({ day: 'mon', dayOfMonth: 3 }, NOW).ok, false);
  });

  it('perto da meia-noite local vale o dia local, não o UTC', () => {
    // 23:30 de sexta em São Paulo já é sábado em UTC.
    const lateFriday = new Date('2026-09-26T02:30:00Z');
    assert.deepEqual(resolveDay({ day: 'today' }, lateFriday), { ok: true, date: '2026-09-25' });
  });
});

describe('resolveRange', () => {
  it('um dia vira [00:00, 00:00 do dia seguinte) com offset explícito', () => {
    const r = resolveRange({ when: 'tomorrow' }, NOW);
    assert.ok(r.ok);
    assert.equal(r.range.from, '2026-09-26T00:00:00-03:00');
    assert.equal(r.range.to, '2026-09-27T00:00:00-03:00');
    assert.equal(r.range.multiDay, false);
    assert.equal(r.range.spoken, 'amanhã, sábado, 26 de setembro');
  });

  it('ausente é hoje', () => {
    const r = resolveRange({}, NOW);
    assert.ok(r.ok);
    assert.equal(r.range.from, '2026-09-25T00:00:00-03:00');
  });

  it('week: 7 dias a partir de hoje', () => {
    const r = resolveRange({ when: 'week' }, NOW);
    assert.ok(r.ok);
    assert.equal(r.range.from, '2026-09-25T00:00:00-03:00');
    assert.equal(r.range.to, '2026-10-02T00:00:00-03:00');
    assert.equal(r.range.multiDay, true);
  });

  it('next_week: de segunda a domingo da semana que vem', () => {
    const r = resolveRange({ when: 'next_week' }, NOW);
    assert.ok(r.ok);
    assert.equal(r.range.from, '2026-09-28T00:00:00-03:00');
    assert.equal(r.range.to, '2026-10-05T00:00:00-03:00');

    // Numa segunda, "semana que vem" é a outra segunda, não hoje.
    const monday = new Date('2026-09-28T13:00:00Z');
    const m = resolveRange({ when: 'next_week' }, monday);
    assert.ok(m.ok);
    assert.equal(m.range.from, '2026-10-05T00:00:00-03:00');
  });

  it('upcoming cobre o horizonte de busca', () => {
    const r = resolveRange({ when: 'upcoming' }, NOW);
    assert.ok(r.ok);
    assert.equal(r.range.to, '2027-03-24T00:00:00-03:00');
  });

  it('intervalo com dia do mês é recusado', () => {
    assert.equal(resolveRange({ when: 'week', dayOfMonth: 3 }, NOW).ok, false);
  });
});

describe('spokenDate', () => {
  it('relativos, dia da semana e data cheia', () => {
    assert.equal(spokenDate('2026-09-25', NOW), 'hoje');
    assert.equal(spokenDate('2026-09-26', NOW), 'amanhã');
    assert.equal(spokenDate('2026-09-24', NOW), 'ontem');
    assert.equal(spokenDate('2026-09-29', NOW), 'terça');
    assert.equal(spokenDate('2026-10-02', NOW), 'dia 2 de outubro');
    assert.equal(spokenDate('2026-09-29', NOW, { withDate: true }), 'terça, 29 de setembro');
  });
});

describe('splitIso', () => {
  it('data pura, hora em -03:00 e hora em outro offset', () => {
    assert.deepEqual(splitIso('2026-09-26'), { date: '2026-09-26', time: null });
    assert.deepEqual(splitIso('2026-09-26T07:00:00-03:00'), { date: '2026-09-26', time: '07:00' });
    // Se a API um dia responder em UTC, a hora de parede é recalculada.
    assert.deepEqual(splitIso('2026-09-26T10:00:00Z'), { date: '2026-09-26', time: '07:00' });
    assert.equal(splitIso('amanhã'), null);
  });
});

describe('dateTimeIso', () => {
  it('monta ISO com offset e recusa horário fora do formato', () => {
    assert.deepEqual(dateTimeIso('2026-09-26', '14:30'), { ok: true, iso: '2026-09-26T14:30:00-03:00' });
    assert.equal(dateTimeIso('2026-09-26', '25:00').ok, false);
    assert.equal(dateTimeIso('2026-09-26', '2pm').ok, false);
  });
});

describe('resolveDay com atTime (mesma regra do set_reminder)', () => {
  // NOW é sexta, 10:00.
  it('sem dia: hoje se ainda não passou, senão amanhã', () => {
    assert.deepEqual(resolveDay({ atTime: '14:00' }, NOW), { ok: true, date: '2026-09-25' });
    assert.deepEqual(resolveDay({ atTime: '09:00' }, NOW), { ok: true, date: '2026-09-26' });
  });

  it('today com a hora passada é erro falável', () => {
    assert.equal(resolveDay({ day: 'today', atTime: '09:00' }, NOW).ok, false);
    assert.deepEqual(resolveDay({ day: 'today', atTime: '11:00' }, NOW), { ok: true, date: '2026-09-25' });
  });

  it('dia da semana que é hoje, com a hora passada, vai para a semana seguinte', () => {
    assert.deepEqual(resolveDay({ day: 'fri', atTime: '09:00' }, NOW), { ok: true, date: '2026-10-02' });
    assert.deepEqual(resolveDay({ day: 'fri', atTime: '14:00' }, NOW), { ok: true, date: '2026-09-25' });
  });

  it('dia do mês que é hoje, com a hora passada, vai para o mês seguinte', () => {
    assert.deepEqual(resolveDay({ dayOfMonth: 25, atTime: '09:00' }, NOW), { ok: true, date: '2026-10-25' });
  });

  it('horário fora do formato é recusado', () => {
    assert.equal(resolveDay({ atTime: '9h' }, NOW).ok, false);
  });
});
