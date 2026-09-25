import {
  LUNA_UTC_OFFSET_MINUTES,
  formatLocalDate,
  localDateTime,
  localWallClockToUtc,
  systemNow,
} from '../time/clock.js';
import { WEEKDAY_LABEL_PT, WEEKDAY_TO_INDEX, parseAtTime } from '../reminders/resolveOnce.js';

/**
 * Tradução da intenção do modelo para as datas que o Compasso aceita.
 *
 * Mesma regra do ADR 006: o modelo manda intenção ("amanhã", "sexta", "dia
 * 30"), nunca data absoluta — ele não sabe que dia é hoje, e uma data
 * alucinada viraria evento no dia errado em silêncio. Quem resolve é o relógio
 * único (`time/clock.ts`), o mesmo do prompt e dos lembretes.
 *
 * O Compasso exige ISO 8601 com offset explícito e responde 400 sem ele. O
 * offset é o fixo de São Paulo (sem DST desde 2019, ver `clock.ts`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Quando é a prova?" procura até aqui. Mesmo teto do guia do Compasso. */
export const SEARCH_HORIZON_DAYS = 180;

/**
 * "dia 30" procura a próxima data com esse dia até aqui. 62 dias cobre o pior
 * caso: hoje é 31 de janeiro e o pedido é "dia 31" — fevereiro não tem, o
 * próximo é 31 de março.
 */
const DAY_OF_MONTH_HORIZON_DAYS = 62;

export const DAY_VALUES = ['today', 'tomorrow', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayValue = (typeof DAY_VALUES)[number];

/** Intervalos que só fazem sentido para consulta, não para criar um item. */
export const RANGE_VALUES = ['week', 'next_week', 'upcoming'] as const;
export type RangeValue = (typeof RANGE_VALUES)[number];

export type QueryWhen = DayValue | RangeValue;

const MES_PT: readonly string[] = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `-03:00`, derivado da constante do relógio em vez de repetido à mão. */
export const LUNA_OFFSET = (() => {
  const abs = Math.abs(LUNA_UTC_OFFSET_MINUTES);
  const sign = LUNA_UTC_OFFSET_MINUTES < 0 ? '-' : '+';
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
})();

/** Meia-noite local de hoje, em epoch ms UTC. */
function todayMidnightUtc(now: Date): number {
  const today = localDateTime(now);
  return localWallClockToUtc({ ...today, hour: 0, minute: 0, second: 0 });
}

/** `"YYYY-MM-DD"` do dia local que fica `offset` dias depois de hoje. */
export function dateAtOffset(now: Date, offset: number): string {
  // Sem DST, um dia local tem sempre 24h reais: somar à meia-noite já cai no
  // dia certo. O `+ DAY_MS / 2` é só folga contra arredondamento de borda.
  return formatLocalDate(new Date(todayMidnightUtc(now) + offset * DAY_MS + DAY_MS / 2));
}

/** Início do dia local em ISO com offset: `2026-09-26T00:00:00-03:00`. */
export function startOfDayIso(date: string): string {
  return `${date}T00:00:00${LUNA_OFFSET}`;
}

/** Dias de calendário entre hoje e `date` (`YYYY-MM-DD`). Negativo no passado. */
export function daysFromToday(date: string, now: Date): number {
  const today = localDateTime(now);
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(today.year, today.month - 1, today.day)) / DAY_MS);
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Um dia: `today`, `tomorrow`, o próximo dia da semana (hoje conta, se for
 * ele) ou o próximo "dia N" do mês. No máximo um dos dois.
 *
 * Com `atTime` (criar evento ou prazo com hora), vale a mesma regra do
 * `resolveOnce` dos lembretes — as duas tools falam o mesmo vocabulário e não
 * podem resolver "sexta às 14h" em dias diferentes:
 * - sem dia: hoje se a hora ainda não passou, senão amanhã;
 * - `today` com a hora já passada: erro falável;
 * - dia da semana ou dia do mês que é hoje, com a hora passada: o próximo.
 */
export function resolveDay(
  input: { day?: DayValue; dayOfMonth?: number; atTime?: string },
  now: Date = systemNow(),
): { ok: true; date: string } | { ok: false; error: string } {
  if (input.day !== undefined && input.dayOfMonth !== undefined) {
    return { ok: false, error: 'diga o dia de um jeito só: dia da semana ou dia do mês' };
  }

  let passedToday = false;
  if (input.atTime !== undefined) {
    const parsed = parseAtTime(input.atTime);
    if (!parsed) return { ok: false, error: `horário "${input.atTime}" fora do formato HH:MM` };
    const dueToday = todayMidnightUtc(now) + parsed.hour * 3_600_000 + parsed.minute * 60_000;
    passedToday = dueToday <= now.getTime();
  }
  // Primeiro dia aceitável: hoje, ou amanhã quando a hora de hoje já passou.
  const first = passedToday ? 1 : 0;

  if (input.dayOfMonth !== undefined) {
    const n = input.dayOfMonth;
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, error: `dia ${n} não existe` };
    }
    for (let offset = first; offset <= DAY_OF_MONTH_HORIZON_DAYS; offset++) {
      const date = dateAtOffset(now, offset);
      if (Number(date.slice(8, 10)) === n) return { ok: true, date };
    }
    return { ok: false, error: `não achei um dia ${n} nos próximos meses` };
  }

  if (input.day === undefined) return { ok: true, date: dateAtOffset(now, first) };
  if (input.day === 'today') {
    return passedToday
      ? { ok: false, error: `${input.atTime} de hoje já passou` }
      : { ok: true, date: dateAtOffset(now, 0) };
  }
  if (input.day === 'tomorrow') return { ok: true, date: dateAtOffset(now, 1) };

  let offset = (WEEKDAY_TO_INDEX[input.day] - localDateTime(now).weekday + 7) % 7;
  if (offset === 0 && passedToday) offset = 7;
  return { ok: true, date: dateAtOffset(now, offset) };
}

export interface ResolvedRange {
  /** Inclusivo, ISO com offset. */
  from: string;
  /** Exclusivo, ISO com offset — o `[from, to)` do Compasso. */
  to: string;
  /** Como a Luna diz o período: "amanhã, sexta, 26 de setembro". */
  spoken: string;
  /** Mais de um dia: cada item precisa dizer em que dia cai. */
  multiDay: boolean;
}

/**
 * O intervalo de uma consulta. `week` são os 7 dias a partir de hoje (receita
 * "minha semana" do Compasso); `next_week` vai de segunda a domingo da semana
 * seguinte; `upcoming` é o horizonte de busca, para "quando é a prova?".
 */
export function resolveRange(
  input: { when?: QueryWhen; dayOfMonth?: number },
  now: Date = systemNow(),
): { ok: true; range: ResolvedRange } | { ok: false; error: string } {
  const { when } = input;

  if (when === 'week' || when === 'next_week' || when === 'upcoming') {
    if (input.dayOfMonth !== undefined) {
      return { ok: false, error: 'diga o período de um jeito só' };
    }
    let start: number;
    let days: number;
    let spoken: string;
    if (when === 'week') {
      start = 0;
      days = 7;
      spoken = 'os próximos sete dias';
    } else if (when === 'next_week') {
      // Segunda que vem; se hoje é segunda, a da semana seguinte.
      start = (1 - localDateTime(now).weekday + 7) % 7 || 7;
      days = 7;
      spoken = 'a semana que vem';
    } else {
      start = 0;
      days = SEARCH_HORIZON_DAYS;
      spoken = 'os próximos meses';
    }
    return {
      ok: true,
      range: {
        from: startOfDayIso(dateAtOffset(now, start)),
        to: startOfDayIso(dateAtOffset(now, start + days)),
        spoken,
        multiDay: true,
      },
    };
  }

  const day = resolveDay({ day: when, dayOfMonth: input.dayOfMonth }, now);
  if (!day.ok) return day;

  const next = dateAtOffset(now, daysFromToday(day.date, now) + 1);
  return {
    ok: true,
    range: {
      from: startOfDayIso(day.date),
      to: startOfDayIso(next),
      spoken: spokenDate(day.date, now, { withDate: true }),
      multiDay: false,
    },
  };
}

/**
 * "hoje", "amanhã", "sexta", "dia 30 de setembro". Com `withDate`, os
 * relativos ganham a data junto ("amanhã, sexta, 26 de setembro"): a Luna
 * confirma por ela, e é o que desfaz um "sexta" que o usuário achou que era
 * outra.
 */
export function spokenDate(date: string, now: Date, opts: { withDate?: boolean } = {}): string {
  const days = daysFromToday(date, now);
  const weekday = WEEKDAY_LABEL_PT[weekdayOf(date)];
  const full = `${Number(date.slice(8, 10))} de ${MES_PT[Number(date.slice(5, 7)) - 1]}`;

  if (days === 0) return opts.withDate ? `hoje, ${weekday}, ${full}` : 'hoje';
  if (days === 1) return opts.withDate ? `amanhã, ${weekday}, ${full}` : 'amanhã';
  if (days === -1) return 'ontem';
  if (days > 1 && days < 7) return opts.withDate ? `${weekday}, ${full}` : weekday;
  return `dia ${full}`;
}

/**
 * O que o Compasso devolve, decomposto: data local e hora ("HH:MM") ou `null`
 * para data pura (dia inteiro, prazo sem hora). As respostas vêm sempre em
 * -03:00, então a hora de parede já está no texto; quando não estiver (API
 * mudou de fuso), o instante é recalculado pelo relógio único.
 */
export function splitIso(value: string): { date: string; time: string | null } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, time: null };

  if (value.endsWith(LUNA_OFFSET)) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
    if (match) return { date: match[1], time: match[2] };
  }

  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return null;
  const local = localDateTime(new Date(instant));
  return {
    date: `${local.year}-${pad2(local.month)}-${pad2(local.day)}`,
    time: `${pad2(local.hour)}:${pad2(local.minute)}`,
  };
}

/** ISO com offset de uma data local + "HH:MM", ou erro falável. */
export function dateTimeIso(date: string, atTime: string): { ok: true; iso: string } | { ok: false; error: string } {
  const parsed = parseAtTime(atTime);
  if (!parsed) return { ok: false, error: `horário "${atTime}" fora do formato HH:MM` };
  return { ok: true, iso: `${date}T${pad2(parsed.hour)}:${pad2(parsed.minute)}:00${LUNA_OFFSET}` };
}
