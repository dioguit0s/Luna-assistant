import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LUNA_UTC_OFFSET_MINUTES } from '../time/clock.js';
import { MAX_IN_SECONDS, MIN_IN_SECONDS, resolveOnceDueAt } from './resolveOnce.js';

/** Instante cuja hora de parede em São Paulo é `y-m-d hour:minute`. */
const at = (y: number, m: number, d: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - LUNA_UTC_OFFSET_MINUTES * 60_000);

describe('resolveOnceDueAt', () => {
  describe('validação de forma', () => {
    it('rejeita quando nenhum dos dois vem', () => {
      const result = resolveOnceDueAt({}, at(2026, 7, 20, 10));
      assert.equal(result.ok, false);
    });

    it('rejeita quando os dois vêm juntos', () => {
      const result = resolveOnceDueAt(
        { inSeconds: 60, atTime: '07:00' },
        at(2026, 7, 20, 10),
      );
      assert.equal(result.ok, false);
    });

    it('rejeita when_day com in_seconds', () => {
      const result = resolveOnceDueAt(
        { inSeconds: 60, whenDay: 'tomorrow' },
        at(2026, 7, 20, 10),
      );
      assert.equal(result.ok, false);
    });

    it('rejeita at_time fora do formato HH:MM', () => {
      for (const invalido of ['7:00', '25:00', '10:60', 'sete horas', '10:5']) {
        const result = resolveOnceDueAt({ atTime: invalido }, at(2026, 7, 20, 10));
        assert.equal(result.ok, false, `"${invalido}" deveria ser rejeitado`);
      }
    });
  });

  describe('relativo (in_seconds)', () => {
    it('soma segundos ao agora', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ inSeconds: 600 }, now);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, now.getTime() + 600_000);
    });

    it('clampa em MIN_IN_SECONDS, não rejeita', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ inSeconds: 1 }, now);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, now.getTime() + MIN_IN_SECONDS * 1000);
    });

    it('clampa em MAX_IN_SECONDS: um valor alucinado não cria alarme no ano 33000', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ inSeconds: 999_999_999 }, now);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, now.getTime() + MAX_IN_SECONDS * 1000);
    });

    it('fala em segundos, minutos, horas e dias conforme a magnitude', () => {
      const now = at(2026, 7, 20, 10, 0);
      const casos: Array<[number, RegExp]> = [
        [10, /10 segundos/],
        [600, /10 minutos/],
        [90, /2 minutos/],
        [3600, /1 hora\b/],
        [5400, /1 hora e 30 minutos/],
        [86_400, /1 dia\b/],
        [172_800, /2 dias/],
      ];
      for (const [inSeconds, esperado] of casos) {
        const result = resolveOnceDueAt({ inSeconds }, now);
        assert.equal(result.ok, true);
        if (result.ok) assert.match(result.spokenWhen, esperado, `${inSeconds}s`);
      }
    });
  });

  describe('absoluto (at_time) sem when_day — próxima ocorrência', () => {
    it('hoje, se o horário ainda não passou', () => {
      const now = at(2026, 7, 20, 10, 0); // segunda-feira
      const result = resolveOnceDueAt({ atTime: '19:00' }, now);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.dueAtUtc, at(2026, 7, 20, 19, 0).getTime());
        assert.equal(result.spokenWhen, 'hoje às 19:00');
      }
    });

    it('amanhã, se o horário já passou hoje', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ atTime: '07:00' }, now);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.dueAtUtc, at(2026, 7, 21, 7, 0).getTime());
        assert.equal(result.spokenWhen, 'amanhã às 07:00');
      }
    });

    it('exatamente agora conta como já passado (borda estrita)', () => {
      const now = at(2026, 7, 20, 7, 0);
      const result = resolveOnceDueAt({ atTime: '07:00' }, now);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, at(2026, 7, 21, 7, 0).getTime());
    });
  });

  describe('when_day: today', () => {
    it('aceita quando o horário ainda não passou', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ atTime: '19:00', whenDay: 'today' }, now);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.dueAtUtc, at(2026, 7, 20, 19, 0).getTime());
        assert.equal(result.spokenWhen, 'hoje às 19:00');
      }
    });

    it('rejeita quando o horário já passou — "hoje" não pode virar "amanhã" em silêncio', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ atTime: '07:00', whenDay: 'today' }, now);
      assert.equal(result.ok, false);
    });
  });

  describe('when_day: tomorrow', () => {
    it('sempre amanhã, mesmo que o horário já tenha passado hoje', () => {
      const now = at(2026, 7, 20, 10, 0);
      const result = resolveOnceDueAt({ atTime: '07:00', whenDay: 'tomorrow' }, now);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, at(2026, 7, 21, 7, 0).getTime());
    });
  });

  describe('when_day: dia da semana', () => {
    it('"sexta às 20h" numa segunda cai na sexta desta mesma semana', () => {
      const segunda = at(2026, 7, 20, 10, 0); // 2026-07-20 é segunda-feira
      const result = resolveOnceDueAt({ atTime: '20:00', whenDay: 'fri' }, segunda);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.dueAtUtc, at(2026, 7, 24, 20, 0).getTime());
        assert.equal(result.spokenWhen, 'sexta às 20:00');
      }
    });

    it('pedir o próprio dia da semana com horário ainda não passado usa hoje', () => {
      const sexta9h = at(2026, 7, 24, 9, 0);
      const result = resolveOnceDueAt({ atTime: '20:00', whenDay: 'fri' }, sexta9h);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.dueAtUtc, at(2026, 7, 24, 20, 0).getTime());
        assert.equal(result.spokenWhen, 'hoje às 20:00');
      }
    });

    it('pedir o próprio dia da semana com horário já passado pula para a semana seguinte', () => {
      const sextaDeNoite = at(2026, 7, 24, 21, 0);
      const result = resolveOnceDueAt({ atTime: '20:00', whenDay: 'fri' }, sextaDeNoite);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.dueAtUtc, at(2026, 7, 31, 20, 0).getTime());
    });
  });
});
