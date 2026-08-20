/**
 * Fonte única de "agora" do Luna.
 *
 * O prompt do modelo e o agendador precisam concordar sobre que horas são: se o
 * "agora" do modelo e o do servidor divergirem, "amanhã às 7" vira um alarme na
 * hora errada, em silêncio. Por isso toda leitura de hora de parede passa por
 * aqui — nada de `Date.prototype.getHours()`, que devolve a hora local do
 * *processo* e erra por 3 horas num host em UTC (o caso do CI e do systemd sem
 * `TZ=`).
 *
 * America/Sao_Paulo não observa mais horário de verão desde 2019, então o offset
 * é fixo em -03:00. `offsetMinutes()` mede o offset de verdade em vez de assumir
 * o valor, e um teste falha se a zona voltar a ter DST.
 */

export const LUNA_TIME_ZONE = 'America/Sao_Paulo';

/** Offset esperado da zona, em minutos. Fixo desde a abolição do DST em 2019. */
export const LUNA_UTC_OFFSET_MINUTES = -180;

/** Relógio injetável: os testes passam um fake, a produção usa `systemNow`. */
export type NowFn = () => Date;

export const systemNow: NowFn = () => new Date();

/** Instante decomposto na hora de parede de `LUNA_TIME_ZONE`. */
export interface LocalDateTime {
  year: number;
  /** 1-12, não 0-11: aqui não vale a indexação do `Date`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = domingo … 6 = sábado, como `Date.prototype.getDay()`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LUNA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  // `hourCycle: 'h23'` em vez de `hour12: false`: com `hour12` algumas versões
  // do ICU rendem "24" para a meia-noite.
  hourCycle: 'h23',
});

/** Decompõe um instante na hora de parede de São Paulo. */
export function localDateTime(instant: Date = systemNow()): LocalDateTime {
  const parts: Record<string, string> = {};
  for (const { type, value } of partsFormatter.formatToParts(instant)) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayIndex(parts.weekday),
  };
}

function weekdayIndex(short: string | undefined): number {
  const index = short === undefined ? undefined : WEEKDAY_INDEX[short];
  if (index === undefined) {
    // Cair num domingo silencioso aqui viraria recorrência no dia errado.
    throw new Error(`Dia da semana inesperado do Intl: ${String(short)}`);
  }
  return index;
}

/**
 * Offset da zona no instante dado, em minutos (-180 fora de DST).
 *
 * Medido, não assumido: reconstrói o instante a partir da hora de parede e
 * compara com o original.
 */
export function offsetMinutes(instant: Date = systemNow()): number {
  return offsetFrom(localDateTime(instant), instant);
}

function offsetFrom(local: LocalDateTime, instant: Date): number {
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    instant.getUTCMilliseconds(),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `"HH:MM"` na hora de parede de São Paulo. */
export function formatLocalTime(instant: Date = systemNow()): string {
  const { hour, minute } = localDateTime(instant);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** `"YYYY-MM-DD"` na hora de parede de São Paulo. */
export function formatLocalDate(instant: Date = systemNow()): string {
  const { year, month, day } = localDateTime(instant);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * ISO 8601 com offset explícito, ex.: `2026-08-20T07:05:07.042-03:00`.
 *
 * É o timestamp de cada linha de log, então decompõe o instante **uma vez** só:
 * `Intl` é a parte cara e o logger está no caminho quente do TTFAB.
 */
export function formatLocalTimestamp(instant: Date = systemNow()): string {
  const local = localDateTime(instant);
  const ms = String(instant.getUTCMilliseconds()).padStart(3, '0');

  const offset = offsetFrom(local, instant);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);

  const date = `${local.year}-${pad2(local.month)}-${pad2(local.day)}`;
  const time = `${pad2(local.hour)}:${pad2(local.minute)}:${pad2(local.second)}`;

  return `${date}T${time}.${ms}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
