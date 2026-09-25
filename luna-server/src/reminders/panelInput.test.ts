import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePanelReminder } from './panelInput.js';

// 25/09/2026 12:00 em São Paulo (UTC−3).
const NOW = new Date('2026-09-25T15:00:00Z');
const once = (date: string, time = '07:30') => resolvePanelReminder({ room_id: 'quarto', repeat: 'none', date, time }, NOW);

describe('resolvePanelReminder', () => {
  it('hora de parede de São Paulo, não o fuso de quem manda', () => {
    const r = once('2026-09-26');
    assert.ok(r.ok);
    assert.equal(new Date(r.value.nextDueUtc).toISOString(), '2026-09-26T10:30:00.000Z');
  });

  it('data inexistente: 29/02 de ano não bissexto e 31/04', () => {
    assert.equal(once('2027-02-29').ok, false);
    assert.equal(once('2026-04-31').ok, false);
    const fev2028 = new Date('2028-02-20T15:00:00Z');
    assert.equal(resolvePanelReminder({ room_id: 'quarto', repeat: 'none', date: '2028-02-29', time: '07:30' }, fev2028).ok, true, '2028 é bissexto');
  });

  it('janela: pelo menos 10 s à frente e no máximo 30 dias', () => {
    const at = (ms: number): string => {
      const d = new Date(NOW.getTime() + ms - 3 * 3_600_000);
      return d.toISOString().slice(0, 10);
    };
    const r = resolvePanelReminder({ room_id: 'quarto', repeat: 'none', date: '2026-09-25', time: '12:00' }, NOW);
    assert.equal(r.ok, false, 'agora mesmo já passou');
    assert.equal(resolvePanelReminder({ room_id: 'quarto', repeat: 'none', date: '2026-09-25', time: '12:01' }, NOW).ok, true);
    assert.equal(once(at(29 * 86_400_000), '12:00').ok, true);
    assert.equal(once(at(31 * 86_400_000), '12:00').ok, false);
  });

  it('formato: ano de 4 dígitos, HH:MM 24h, sala do padrão do WS', () => {
    assert.equal(once('226-09-26').ok, false);
    assert.equal(once('2026-09-26', '7:30').ok, false);
    assert.equal(once('2026-09-26', '24:00').ok, false);
    const sala = resolvePanelReminder({ room_id: 'Quarto!', repeat: 'none', date: '2026-09-26', time: '07:30' }, NOW);
    assert.equal(sala.ok === false && sala.field, 'room_id');
  });

  it('recorrente: dia da semana vira a regra, sem data', () => {
    const r = resolvePanelReminder({ room_id: 'sala', label: 'lixo', repeat: 'thu', time: '20:00' }, NOW);
    assert.ok(r.ok && r.value.kind === 'recurring');
    assert.equal(r.ok && r.value.kind === 'recurring' && r.value.repeatRule, 'thu');
    // Próxima quinta 20:00 SP = 01/10 23:00 UTC.
    assert.equal(r.ok && new Date(r.value.nextDueUtc).toISOString(), '2026-10-01T23:00:00.000Z');
  });

  it('rótulo: mesmas regras da voz', () => {
    const r = resolvePanelReminder({ room_id: 'sala', label: 'Luna, lembra', repeat: 'daily', time: '08:00' }, NOW);
    assert.equal(r.ok === false && r.field, 'label');
    const vazio = resolvePanelReminder({ room_id: 'sala', label: '   ', repeat: 'daily', time: '08:00' }, NOW);
    assert.equal(vazio.ok && vazio.value.label, null, 'só espaço vira alarme sem rótulo');
  });
});
