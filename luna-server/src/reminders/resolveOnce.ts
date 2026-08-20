import { localDateTime, localWallClockToUtc, systemNow } from '../time/clock.js';

/**
 * O servidor resolve data e hora; o modelo nunca manda instante absoluto
 * (decisão 6 do plano). A tool aceita só intenção — `inSeconds` (relativo) ou
 * `atTime` + `whenDay` (absoluto, "HH:MM" local) — e este módulo converte com
 * o relógio único (`time/clock.ts`), a mesma fonte que o prompt e o
 * `ReminderScheduler` usam.
 */

export const MIN_IN_SECONDS = 10;
/** 30 dias. Um `999999999` alucinado não pode criar alarme no ano 33000. */
export const MAX_IN_SECONDS = 2_592_000;

export type WhenDay = 'today' | 'tomorrow' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ResolveOnceInput {
  inSeconds?: number;
  atTime?: string;
  whenDay?: WhenDay;
}

export type ResolveOnceResult =
  | { ok: true; dueAtUtc: number; spokenWhen: string }
  | { ok: false; error: string };

const AT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `mon`..`sun` → o índice de `LocalDateTime.weekday` (0 = domingo). */
const WEEKDAY_TO_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAY_LABEL_PT: Record<number, string> = {
  0: 'domingo',
  1: 'segunda',
  2: 'terça',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
  6: 'sábado',
};

export function resolveOnceDueAt(input: ResolveOnceInput, now: Date = systemNow()): ResolveOnceResult {
  const hasRelative = input.inSeconds !== undefined;
  const hasAbsolute = input.atTime !== undefined;

  if (hasRelative === hasAbsolute) {
    // A combinação é rejeitada, não resolvida em silêncio: nem "os dois ao
    // mesmo tempo" nem "nenhum dos dois" tem uma leitura única.
    return {
      ok: false,
      error: hasRelative
        ? 'informe só um jeito de dizer a hora: "daqui a X" ou um horário, não os dois'
        : 'faltou dizer quando — "daqui a X minutos" ou um horário',
    };
  }

  if (hasRelative) {
    if (input.whenDay !== undefined) {
      return { ok: false, error: 'um horário relativo não combina com dia da semana' };
    }
    return resolveRelative(input.inSeconds!, now);
  }

  return resolveAbsolute(input.atTime!, input.whenDay, now);
}

function resolveRelative(inSecondsRaw: number, now: Date): ResolveOnceResult {
  // Clampado, não rejeitado: um valor absurdo alucinado pelo modelo vira o
  // extremo válido mais próximo, em vez de travar o pedido do usuário.
  const inSeconds = Math.min(Math.max(Math.round(inSecondsRaw), MIN_IN_SECONDS), MAX_IN_SECONDS);

  return {
    ok: true,
    dueAtUtc: now.getTime() + inSeconds * 1000,
    spokenWhen: humanizeSeconds(inSeconds),
  };
}

function resolveAbsolute(atTime: string, whenDay: WhenDay | undefined, now: Date): ResolveOnceResult {
  if (!AT_TIME_PATTERN.test(atTime)) {
    return { ok: false, error: `horário "${atTime}" fora do formato HH:MM` };
  }

  const [hourStr, minuteStr] = atTime.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  const today = localDateTime(now);
  const todayMidnightUtc = localWallClockToUtc({ ...today, hour: 0, minute: 0, second: 0 });
  const dayMs = 24 * 60 * 60 * 1000;
  const timeOfDayMs = hour * 3_600_000 + minute * 60_000;

  // Sem DST, um dia local é sempre exatamente 24h reais: somar dayOffset*dayMs
  // à meia-noite de hoje já cai certo na meia-noite do dia alvo, sem precisar
  // decompor de novo em ano/mês/dia.
  const dueAtDay = (dayOffset: number): number => todayMidnightUtc + dayOffset * dayMs + timeOfDayMs;

  if (whenDay === 'today') {
    const dueAtUtc = dueAtDay(0);
    if (dueAtUtc <= now.getTime()) {
      return { ok: false, error: `${atTime} de hoje já passou` };
    }
    return { ok: true, dueAtUtc, spokenWhen: `hoje às ${atTime}` };
  }

  if (whenDay === 'tomorrow') {
    return { ok: true, dueAtUtc: dueAtDay(1), spokenWhen: `amanhã às ${atTime}` };
  }

  if (whenDay !== undefined) {
    const targetWeekday = WEEKDAY_TO_INDEX[whenDay];
    let offset = (targetWeekday - today.weekday + 7) % 7;
    if (offset === 0 && dueAtDay(0) <= now.getTime()) {
      // Hoje é o dia certo, mas o horário já passou: só a próxima semana.
      offset = 7;
    }
    return {
      ok: true,
      dueAtUtc: dueAtDay(offset),
      spokenWhen: spokenForOffset(offset, today.weekday, atTime),
    };
  }

  // Sem when_day: "próxima ocorrência de at_time" — hoje se ainda não passou,
  // amanhã caso contrário.
  const todayAttempt = dueAtDay(0);
  if (todayAttempt > now.getTime()) {
    return { ok: true, dueAtUtc: todayAttempt, spokenWhen: `hoje às ${atTime}` };
  }
  return { ok: true, dueAtUtc: dueAtDay(1), spokenWhen: `amanhã às ${atTime}` };
}

function spokenForOffset(offset: number, todayWeekday: number, atTime: string): string {
  if (offset === 0) return `hoje às ${atTime}`;
  if (offset === 1) return `amanhã às ${atTime}`;
  const weekday = WEEKDAY_LABEL_PT[(todayWeekday + offset) % 7];
  return `${weekday} às ${atTime}`;
}

/** "daqui a X segundos/minutos/horas/dias", arredondado para a maior unidade legível. */
function humanizeSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `daqui a ${totalSeconds} segundos`;

  if (totalSeconds < 3600) {
    const minutes = Math.round(totalSeconds / 60);
    return `daqui a ${minutes} minuto${minutes === 1 ? '' : 's'}`;
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.round((totalSeconds % 3600) / 60);
    const horaPart = `${hours} hora${hours === 1 ? '' : 's'}`;
    return minutes === 0 ? `daqui a ${horaPart}` : `daqui a ${horaPart} e ${minutes} minutos`;
  }

  const days = Math.round(totalSeconds / 86_400);
  return `daqui a ${days} dia${days === 1 ? '' : 's'}`;
}
