import { localDateTime, localWallClockToUtc, systemNow } from '../time/clock.js';
import { parseAtTime, WEEKDAY_TO_INDEX, WEEKDAY_LABEL_PT, type WhenDay } from './resolveOnce.js';
import type { Reminder, RepeatRule } from './ReminderStore.js';

/**
 * Aritmética de recorrência: "todo dia útil às 6:30", "toda sexta às 20h".
 *
 * Tudo aqui é soma sobre offset fixo, não motor de fuso genérico: o Brasil
 * aboliu o horário de verão em 2019 e `time/clock.ts` fixa -03:00. Sem DST, um
 * dia local é sempre exatamente 24 h reais, e "próxima ocorrência" vira
 * aritmética simples. Há teste que falha se essa premissa cair.
 */

/** O campo `repeat` da tool — não confundir com o `repeat_rule` do banco. */
export type RepeatField = 'none' | 'daily' | 'weekdays' | 'weekend' | 'weekly';

export const REPEAT_FIELD_VALUES: RepeatField[] = [
  'none',
  'daily',
  'weekdays',
  'weekend',
  'weekly',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rótulo falável de cada regra, com o dia da semana resolvido quando for o caso. */
const REPEAT_LABEL_PT: Record<string, string> = {
  daily: 'todo dia',
  weekdays: 'todo dia útil',
  weekend: 'todo fim de semana',
};

export type ResolveRecurringInput = {
  atTime: string;
  repeat: Exclude<RepeatField, 'none'>;
  whenDay?: WhenDay;
};

export type ResolveRecurringResult =
  | {
      ok: true;
      localHour: number;
      localMinute: number;
      repeatRule: RepeatRule;
      firstDueUtc: number;
      spokenWhen: string;
    }
  | { ok: false; error: string };

/** A regra cobre este dia da semana? (0 = domingo, como `LocalDateTime.weekday`) */
function ruleMatchesWeekday(rule: RepeatRule, weekday: number): boolean {
  switch (rule) {
    case 'daily':
      return true;
    case 'weekdays':
      return weekday >= 1 && weekday <= 5;
    case 'weekend':
      return weekday === 0 || weekday === 6;
    default:
      return WEEKDAY_TO_INDEX[rule] === weekday;
  }
}

/**
 * Próxima ocorrência **estritamente depois** de `after`.
 *
 * Deriva sempre de `local_hour`/`local_minute` + regra, nunca de
 * `after + delta`. Isso não é detalhe: a soneca sobrescreve `next_due_utc`
 * (é um `UPDATE`, sem tabela à parte), então um cálculo incremental faria o
 * recorrente sair do horário de parede um pouco mais a cada soneca — "todo dia
 * às 6:30" viraria 6:35, 6:40, 6:45.
 */
export function nextOccurrenceAfter(
  rule: RepeatRule,
  localHour: number,
  localMinute: number,
  after: number,
): number {
  const partes = localDateTime(new Date(after));
  const meiaNoiteUtc = localWallClockToUtc({ ...partes, hour: 0, minute: 0, second: 0 });
  const horaDoDiaMs = localHour * 3_600_000 + localMinute * 60_000;

  // 8 voltas cobrem toda regra: `daily` acerta em 0 ou 1, um dia da semana
  // específico em até 7.
  for (let offset = 0; offset <= 7; offset++) {
    const weekday = (partes.weekday + offset) % 7;
    if (!ruleMatchesWeekday(rule, weekday)) continue;

    const candidato = meiaNoiteUtc + offset * DAY_MS + horaDoDiaMs;
    if (candidato > after) return candidato;
  }

  // Inalcançável para as regras válidas, mas o tipo não sabe disso: uma semana
  // à frente é melhor que devolver algo no passado.
  return meiaNoiteUtc + 7 * DAY_MS + horaDoDiaMs;
}

/**
 * `NextDueFn` do `ReminderScheduler`. Sem ela injetada, o default
 * `REFUSE_RECURRING` transforma todo recorrente em `missed`.
 */
export function nextDueAfter(reminder: Reminder, after: number): number | null {
  if (
    reminder.kind !== 'recurring' ||
    reminder.repeatRule === null ||
    reminder.localHour === null ||
    reminder.localMinute === null
  ) {
    return null;
  }

  return nextOccurrenceAfter(reminder.repeatRule, reminder.localHour, reminder.localMinute, after);
}

/**
 * Traduz o par (`repeat`, `when_day`) da tool para o que o banco guarda.
 *
 * A tradução vive num ponto só: `repeat: 'weekly'` + `when_day: 'fri'` vira
 * `repeat_rule = 'fri'`, e é isso que distingue "sexta às 20h" (uma vez) de
 * "toda sexta às 20h" — a distinção que um CSV de dias da semana não faz.
 */
export function resolveRecurring(
  input: ResolveRecurringInput,
  now: Date = systemNow(),
): ResolveRecurringResult {
  const parsed = parseAtTime(input.atTime);
  if (!parsed) {
    return { ok: false, error: `horário "${input.atTime}" fora do formato HH:MM` };
  }

  const regra = resolveRule(input.repeat, input.whenDay);
  if (regra.ok === false) return regra;

  const firstDueUtc = nextOccurrenceAfter(
    regra.rule,
    parsed.hour,
    parsed.minute,
    now.getTime(),
  );

  return {
    ok: true,
    localHour: parsed.hour,
    localMinute: parsed.minute,
    repeatRule: regra.rule,
    firstDueUtc,
    spokenWhen: `${spokenRule(regra.rule)} às ${input.atTime}`,
  };
}

function resolveRule(
  repeat: Exclude<RepeatField, 'none'>,
  whenDay: WhenDay | undefined,
): { ok: true; rule: RepeatRule } | { ok: false; error: string } {
  if (repeat === 'weekly') {
    // "toda semana" sem dizer qual dia não tem leitura única — e chutar o dia
    // de hoje daria um alarme semanal no dia errado, em silêncio.
    if (whenDay === undefined || !(whenDay in WEEKDAY_TO_INDEX)) {
      return { ok: false, error: 'toda semana em qual dia?' };
    }
    return { ok: true, rule: whenDay as RepeatRule };
  }

  // `daily`/`weekdays`/`weekend` já dizem quais dias são. Um dia da semana
  // junto é contradição ("todo dia" e "na sexta" ao mesmo tempo), e resolver
  // isso em silêncio criaria o alarme errado.
  if (whenDay !== undefined && whenDay in WEEKDAY_TO_INDEX) {
    return { ok: false, error: 'é todo dia ou só nesse dia da semana?' };
  }

  return { ok: true, rule: repeat };
}

/** "todo dia útil", "toda sexta" — o rótulo falável de uma regra de repetição. */
export function spokenRule(rule: RepeatRule): string {
  const fixo = REPEAT_LABEL_PT[rule];
  if (fixo) return fixo;

  const weekday = WEEKDAY_TO_INDEX[rule];
  const nome = WEEKDAY_LABEL_PT[weekday];
  // "todo domingo"/"todo sábado", mas "toda segunda"/"toda sexta".
  const artigo = weekday === 0 || weekday === 6 ? 'todo' : 'toda';
  return `${artigo} ${nome}`;
}
