import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDateTime, localWallClockToUtc, LUNA_UTC_OFFSET_MINUTES } from '../time/clock.js';
import { nextOccurrenceAfter, nextDueAfter, resolveRecurring } from './recurrence.js';
import type { Reminder, RepeatRule } from './ReminderStore.js';

/** 2026-08-20 é uma quinta-feira. 12:00 UTC = 09:00 em São Paulo. */
const QUINTA_09H = Date.UTC(2026, 7, 20, 12, 0, 0);
const DIA_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD HH:MM (dia da semana)" no relógio local, para asserção legível. */
function local(instant: number): string {
  const p = localDateTime(new Date(instant));
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${dias[p.weekday]})`;
}

describe('nextOccurrenceAfter', () => {
  const casos: Array<{
    nome: string;
    rule: RepeatRule;
    hora: [number, number];
    depois: number;
    esperado: string;
  }> = [
    {
      nome: 'diário mais tarde hoje: cai hoje mesmo',
      rule: 'daily',
      hora: [20, 0],
      depois: QUINTA_09H,
      esperado: '2026-08-20 20:00 (qui)',
    },
    {
      nome: 'diário com o horário já passado: cai amanhã',
      rule: 'daily',
      hora: [6, 30],
      depois: QUINTA_09H,
      esperado: '2026-08-21 06:30 (sex)',
    },
    {
      nome: 'dia útil na quinta de manhã: ainda hoje',
      rule: 'weekdays',
      hora: [18, 0],
      depois: QUINTA_09H,
      esperado: '2026-08-20 18:00 (qui)',
    },
    {
      nome: 'dia útil na sexta à noite: pula o fim de semana e cai na segunda',
      rule: 'weekdays',
      hora: [6, 30],
      depois: QUINTA_09H + DIA_MS + 12 * 3_600_000, // sexta 21:00 local
      esperado: '2026-08-24 06:30 (seg)',
    },
    {
      nome: 'fim de semana na quinta: cai no sábado',
      rule: 'weekend',
      hora: [9, 0],
      depois: QUINTA_09H,
      esperado: '2026-08-22 09:00 (sáb)',
    },
    {
      nome: 'fim de semana no sábado à noite: cai no domingo',
      rule: 'weekend',
      hora: [9, 0],
      depois: QUINTA_09H + 2 * DIA_MS + 12 * 3_600_000, // sábado 21:00 local
      esperado: '2026-08-23 09:00 (dom)',
    },
    {
      nome: 'toda sexta, pedido na quinta: amanhã',
      rule: 'fri',
      hora: [20, 0],
      depois: QUINTA_09H,
      esperado: '2026-08-21 20:00 (sex)',
    },
    {
      nome: 'toda quinta, com o horário de hoje já passado: só na semana que vem',
      rule: 'thu',
      hora: [8, 0],
      depois: QUINTA_09H,
      esperado: '2026-08-27 08:00 (qui)',
    },
    {
      nome: 'virada de mês: toda segunda no fim de agosto cai em setembro',
      rule: 'mon',
      hora: [7, 0],
      depois: Date.UTC(2026, 7, 31, 13, 0, 0), // segunda 31/08, 10:00 local
      esperado: '2026-09-07 07:00 (seg)',
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const proxima = nextOccurrenceAfter(caso.rule, caso.hora[0], caso.hora[1], caso.depois);
      assert.equal(local(proxima), caso.esperado);
      assert.ok(proxima > caso.depois, 'a próxima ocorrência tem que ser estritamente futura');
    });
  }

  it('sempre avança: aplicar em cadeia nunca volta no tempo nem trava', () => {
    let cursor = QUINTA_09H;
    for (let i = 0; i < 30; i++) {
      const proxima = nextOccurrenceAfter('weekdays', 6, 30, cursor);
      assert.ok(proxima > cursor, `iteração ${i} não avançou`);
      const weekday = localDateTime(new Date(proxima)).weekday;
      assert.ok(weekday >= 1 && weekday <= 5, 'weekdays nunca pode cair no fim de semana');
      cursor = proxima;
    }
  });

  it('deriva da hora de parede, não do instante anterior: soneca não faz o alarme migrar', () => {
    // A soneca sobrescreve `next_due_utc` (é um UPDATE, sem tabela à parte).
    // Se a recorrência fosse `after + delta`, "todo dia às 6:30" viraria 6:35,
    // 6:40, 6:45 — um pouco mais tarde a cada soneca.
    const adiado = QUINTA_09H + 37 * 60_000;
    const proxima = nextOccurrenceAfter('daily', 6, 30, adiado);
    assert.equal(local(proxima), '2026-08-21 06:30 (sex)');
  });
});

describe('nextDueAfter (NextDueFn do scheduler)', () => {
  const base: Reminder = {
    id: 1,
    shortId: 'A7K3',
    roomId: 'sala_de_estar',
    label: null,
    kind: 'recurring',
    dueAtUtc: null,
    localHour: 6,
    localMinute: 30,
    repeatRule: 'daily',
    nextDueUtc: QUINTA_09H,
    status: 'armed',
    createdAt: QUINTA_09H,
    updatedAt: QUINTA_09H,
    lastFiredAt: null,
    fireCount: 0,
  };

  it('resolve um recorrente bem formado', () => {
    assert.equal(local(nextDueAfter(base, QUINTA_09H)!), '2026-08-21 06:30 (sex)');
  });

  it('devolve null para one-shot ou recorrente sem regra — o scheduler marca missed', () => {
    assert.equal(nextDueAfter({ ...base, kind: 'once' }, QUINTA_09H), null);
    assert.equal(nextDueAfter({ ...base, repeatRule: null }, QUINTA_09H), null);
    assert.equal(nextDueAfter({ ...base, localHour: null }, QUINTA_09H), null);
  });
});

describe('resolveRecurring', () => {
  const agora = new Date(QUINTA_09H);

  it('"todo dia útil às 6:30" vira weekdays com a hora local guardada', () => {
    const r = resolveRecurring({ atTime: '06:30', repeat: 'weekdays' }, agora);
    assert.equal(r.ok, true);
    if (!r.ok) return;

    assert.equal(r.repeatRule, 'weekdays');
    assert.equal(r.localHour, 6);
    assert.equal(r.localMinute, 30);
    assert.equal(r.spokenWhen, 'todo dia útil às 06:30');
    assert.equal(local(r.firstDueUtc), '2026-08-21 06:30 (sex)');
  });

  it('"toda sexta às 20h" é weekly + when_day, e vira o dia da semana no banco', () => {
    const r = resolveRecurring({ atTime: '20:00', repeat: 'weekly', whenDay: 'fri' }, agora);
    assert.equal(r.ok, true);
    if (!r.ok) return;

    // É esta tradução que distingue "sexta às 20h" (uma vez) de "toda sexta".
    assert.equal(r.repeatRule, 'fri');
    assert.equal(r.spokenWhen, 'toda sexta às 20:00');
  });

  it('a fala do rótulo concorda com o dia: "todo sábado", "toda segunda"', () => {
    const sabado = resolveRecurring({ atTime: '10:00', repeat: 'weekly', whenDay: 'sat' }, agora);
    const segunda = resolveRecurring({ atTime: '10:00', repeat: 'weekly', whenDay: 'mon' }, agora);
    assert.equal(sabado.ok && sabado.spokenWhen, 'todo sábado às 10:00');
    assert.equal(segunda.ok && segunda.spokenWhen, 'toda segunda às 10:00');
  });

  it('weekly sem dia da semana é rejeitado com pergunta falável, não resolvido no chute', () => {
    for (const input of [
      { atTime: '20:00', repeat: 'weekly' as const },
      { atTime: '20:00', repeat: 'weekly' as const, whenDay: 'tomorrow' as const },
    ]) {
      const r = resolveRecurring(input, agora);
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.error, 'toda semana em qual dia?');
    }
  });

  it('"todo dia" com um dia da semana junto é contradição, não é resolvido em silêncio', () => {
    const r = resolveRecurring({ atTime: '07:00', repeat: 'daily', whenDay: 'fri' }, agora);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error, 'é todo dia ou só nesse dia da semana?');
  });

  it('horário fora do formato é rejeitado pelo mesmo padrão do one-shot', () => {
    const r = resolveRecurring({ atTime: '25:00', repeat: 'daily' }, agora);
    assert.equal(r.ok, false);
  });
});

describe('premissa de fuso', () => {
  it('tripwire de DST: toda a aritmética assume dia local de 24h exatas', () => {
    // Se um dia a zona ganhar horário de verão, este teste falha ANTES de os
    // alarmes recorrentes começarem a tocar uma hora fora — que é uma falha
    // silenciosa muito mais cara de descobrir.
    assert.equal(LUNA_UTC_OFFSET_MINUTES, -180);

    const janeiro = Date.UTC(2027, 0, 15, 12, 0, 0);
    const julho = Date.UTC(2027, 6, 15, 12, 0, 0);
    for (const instante of [janeiro, julho]) {
      const p = localDateTime(new Date(instante));
      const meiaNoite = localWallClockToUtc({ ...p, hour: 0, minute: 0, second: 0 });
      const meiaNoiteSeguinte = localWallClockToUtc({
        ...localDateTime(new Date(instante + DIA_MS)),
        hour: 0,
        minute: 0,
        second: 0,
      });
      assert.equal(
        meiaNoiteSeguinte - meiaNoite,
        DIA_MS,
        'um dia local deixou de ter 24h: a recorrência precisa de motor de fuso de verdade',
      );
    }
  });
});
