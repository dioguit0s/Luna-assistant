import type { RepeatRule } from './ReminderStore.js';
import { parseAtTime, MAX_IN_SECONDS, MIN_IN_SECONDS } from './resolveOnce.js';
import { nextOccurrenceAfter } from './recurrence.js';
import { localWallClockToUtc } from '../time/clock.js';
import { sanitizeLabel } from '../orchestrator/tools/setReminder.js';
import { ROOM_ID_PATTERN } from '../settings/groups.js';

/**
 * Lembrete vindo do painel (v2): o corpo de `POST /admin/v1/reminders` e de
 * `PUT reminders/:id`.
 *
 * Mesmo contrato de tempo do ADR 006 que a tool `set_reminder`: o painel manda
 * **hora de parede** em America/Sao_Paulo (`date` + `time`), nunca um instante
 * calculado do lado dele — quem converte é o relógio único do servidor. As
 * validações de rótulo são as mesmas da voz (`sanitizeLabel`).
 *
 * ```json
 * { "room_id": "quarto", "label": "remédio", "repeat": "none", "date": "2026-09-26", "time": "07:30" }
 * { "room_id": "quarto", "label": null, "repeat": "weekdays", "time": "06:30" }
 * ```
 */

export const PANEL_REPEAT_VALUES = [
  'none',
  'daily',
  'weekdays',
  'weekend',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type PanelReminder =
  | { roomId: string; label: string | null; kind: 'once'; dueAtUtc: number; nextDueUtc: number }
  | {
      roomId: string;
      label: string | null;
      kind: 'recurring';
      localHour: number;
      localMinute: number;
      repeatRule: RepeatRule;
      nextDueUtc: number;
    };

export type PanelReminderResult =
  | { ok: true; value: PanelReminder }
  | { ok: false; field: string; error: string };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function resolvePanelReminder(body: unknown, now: Date): PanelReminderResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, field: 'body', error: 'corpo deve ser um objeto JSON' };
  }
  const b = body as Record<string, unknown>;

  const roomId = b.room_id;
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    return { ok: false, field: 'room_id', error: 'sala fora do formato' };
  }

  if (b.label !== undefined && b.label !== null && typeof b.label !== 'string') {
    return { ok: false, field: 'label', error: '"label" deve ser texto ou null' };
  }
  const label = sanitizeLabel(typeof b.label === 'string' ? b.label : undefined);
  if (label.ok === false) return { ok: false, field: 'label', error: label.error };

  if (typeof b.time !== 'string') return { ok: false, field: 'time', error: 'horário obrigatório' };
  const time = parseAtTime(b.time);
  if (!time) return { ok: false, field: 'time', error: 'horário fora do formato HH:MM' };

  const repeat = b.repeat ?? 'none';
  if (typeof repeat !== 'string' || !(PANEL_REPEAT_VALUES as readonly string[]).includes(repeat)) {
    return { ok: false, field: 'repeat', error: 'repetição desconhecida' };
  }

  if (repeat === 'none') {
    if (typeof b.date !== 'string') return { ok: false, field: 'date', error: 'data obrigatória' };
    const m = DATE_PATTERN.exec(b.date);
    if (!m) return { ok: false, field: 'date', error: 'data fora do formato AAAA-MM-DD' };
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dueAtUtc = localWallClockToUtc({ year, month, day, hour: time.hour, minute: time.minute });
    // `Date.UTC` normaliza 31/02 em 03/03 em silêncio — recusa em vez de marcar
    // o dia errado.
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return { ok: false, field: 'date', error: 'data inexistente' };
    }
    const delta = dueAtUtc - now.getTime();
    if (delta < MIN_IN_SECONDS * 1000) return { ok: false, field: 'date', error: 'esse horário já passou' };
    if (delta > MAX_IN_SECONDS * 1000) return { ok: false, field: 'date', error: 'no máximo 30 dias à frente' };
    return { ok: true, value: { roomId, label: label.value, kind: 'once', dueAtUtc, nextDueUtc: dueAtUtc } };
  }

  const repeatRule = repeat as RepeatRule;
  return {
    ok: true,
    value: {
      roomId,
      label: label.value,
      kind: 'recurring',
      localHour: time.hour,
      localMinute: time.minute,
      repeatRule,
      nextDueUtc: nextOccurrenceAfter(repeatRule, time.hour, time.minute, now.getTime()),
    },
  };
}
