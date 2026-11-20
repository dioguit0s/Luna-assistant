import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AgendaLogAction, AgendaLogEntry, AgendaTool } from '../calendar/agendaLog.js';

/**
 * Wrapper das tabelas `latency_samples`, `error_log` e `reminder_events`
 * (migração 4 do `ReminderStore`, mesmo banco) e `agenda_events` (migração 5).
 * Único ponto de SQL do diagnóstico.
 *
 * Retenção: 30 dias **ou** 10 mil linhas por tabela, o que vier primeiro. A
 * poda é do `Diagnostics`, num timer próprio — nunca na mesma volta do event
 * loop de uma inserção, que acontece no caminho do áudio (ver lá).
 */

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ROWS = 10_000;

export interface LatencySample {
  at: number;
  roomId: string;
  deviceId: string | null;
  provider: string;
  latencyMs: number;
  sinceTurnStartMs: number | null;
  providerWaitMs: number | null;
  sessionCold: boolean;
}

export interface ErrorEntry {
  id: number;
  at: number;
  level: string;
  event: string | null;
  roomId: string | null;
  msg: string;
  /** Campos escalares do log, em JSON (ver `logTap.ts`). */
  detail: Record<string, unknown> | null;
}

export type ReminderEventKind =
  | 'created'
  | 'edited'
  | 'fired'
  | 'dismissed'
  | 'snoozed'
  | 'exhausted'
  | 'missed'
  | 'cancelled';

export interface ReminderEvent {
  id: number;
  at: number;
  reminderId: number;
  kind: ReminderEventKind;
  roomId: string | null;
  via: string | null;
  /** Do `reminders` na hora da leitura; `null` se a linha já foi podada. */
  label: string | null;
  shortId: string | null;
}

export interface AgendaEvent extends AgendaLogEntry {
  id: number;
}

/** Tabelas podadas por idade e por teto de linhas. */
const PRUNED_TABLES = ['latency_samples', 'error_log', 'reminder_events', 'agenda_events'] as const;

export class DiagnosticsStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  insertLatency(s: LatencySample): void {
    this.stmt(
      `INSERT INTO latency_samples
         (at, room_id, device_id, provider, latency_ms, since_turn_start_ms, provider_wait_ms, session_cold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.at,
      s.roomId,
      s.deviceId,
      s.provider,
      Math.round(s.latencyMs),
      s.sinceTurnStartMs === null ? null : Math.round(s.sinceTurnStartMs),
      s.providerWaitMs === null ? null : Math.round(s.providerWaitMs),
      s.sessionCold ? 1 : 0,
    );
  }

  insertError(e: Omit<ErrorEntry, 'id'>): void {
    this.stmt(
      'INSERT INTO error_log (at, level, event, room_id, msg, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(e.at, e.level, e.event, e.roomId, e.msg, e.detail ? JSON.stringify(e.detail) : null);
  }

  insertReminderEvent(e: Omit<ReminderEvent, 'id' | 'label' | 'shortId'>): void {
    this.stmt(
      'INSERT INTO reminder_events (at, reminder_id, kind, room_id, via) VALUES (?, ?, ?, ?, ?)',
    ).run(e.at, e.reminderId, e.kind, e.roomId, e.via);
  }

  /** Mais recentes primeiro, com rótulo e `short_id` atuais do lembrete. */
  reminderHistory(limit: number): ReminderEvent[] {
    return this.stmt(
      `SELECT e.id, e.at, e.reminder_id, e.kind, e.room_id, e.via, r.label, r.short_id
         FROM reminder_events e LEFT JOIN reminders r ON r.id = e.reminder_id
        ORDER BY e.at DESC, e.id DESC LIMIT ?`,
    )
      .all(limit)
      .map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        reminderId: Number(r.reminder_id),
        kind: String(r.kind) as ReminderEventKind,
        roomId: r.room_id === null ? null : String(r.room_id),
        via: r.via === null ? null : String(r.via),
        label: r.label === null || r.label === undefined ? null : String(r.label),
        shortId: r.short_id === null || r.short_id === undefined ? null : String(r.short_id),
      }));
  }

  insertAgendaEvent(e: AgendaLogEntry): void {
    this.stmt(
      `INSERT INTO agenda_events
         (at, room_id, tool, action, when_arg, day_of_month, kind, effort, attribute, has_search,
          result, item_count, item_id, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.at,
      e.roomId,
      e.tool,
      e.action,
      e.when,
      e.dayOfMonth,
      e.kind,
      e.effort,
      e.attribute,
      e.hasSearch ? 1 : 0,
      e.result,
      e.itemCount,
      e.itemId,
      e.latencyMs === null ? null : Math.round(e.latencyMs),
    );
  }

  /** Mais recentes primeiro. */
  agendaHistory(limit: number): AgendaEvent[] {
    return this.stmt(
      `SELECT id, at, room_id, tool, action, when_arg, day_of_month, kind, effort, attribute, has_search,
              result, item_count, item_id, latency_ms
         FROM agenda_events ORDER BY at DESC, id DESC LIMIT ?`,
    )
      .all(limit)
      .map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        roomId: r.room_id === null ? '' : String(r.room_id),
        tool: String(r.tool) as AgendaTool,
        action: r.action === null ? null : (String(r.action) as AgendaLogAction),
        when: r.when_arg === null ? null : String(r.when_arg),
        dayOfMonth: r.day_of_month === null ? null : Number(r.day_of_month),
        kind: r.kind === null ? null : String(r.kind),
        effort: r.effort === null ? null : Number(r.effort),
        attribute: r.attribute === null ? null : String(r.attribute),
        hasSearch: Number(r.has_search) === 1,
        result: String(r.result),
        itemCount: r.item_count === null ? null : Number(r.item_count),
        itemId: r.item_id === null ? null : String(r.item_id),
        latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      }));
  }

  /** Amostras desde `sinceMs`, mais antigas primeiro. */
  latencySince(sinceMs: number, limit = MAX_ROWS): LatencySample[] {
    return this.stmt(
      `SELECT at, room_id, device_id, provider, latency_ms, since_turn_start_ms, provider_wait_ms, session_cold
         FROM latency_samples WHERE at >= ? ORDER BY at DESC LIMIT ?`,
    )
      .all(sinceMs, limit)
      .reverse()
      .map((r) => ({
        at: Number(r.at),
        roomId: String(r.room_id),
        deviceId: r.device_id === null ? null : String(r.device_id),
        provider: String(r.provider),
        latencyMs: Number(r.latency_ms),
        sinceTurnStartMs: r.since_turn_start_ms === null ? null : Number(r.since_turn_start_ms),
        providerWaitMs: r.provider_wait_ms === null ? null : Number(r.provider_wait_ms),
        sessionCold: Number(r.session_cold) === 1,
      }));
  }

  /** Mais recentes primeiro. */
  recentErrors(limit: number): ErrorEntry[] {
    return this.stmt(
      'SELECT id, at, level, event, room_id, msg, detail FROM error_log ORDER BY at DESC, id DESC LIMIT ?',
    )
      .all(limit)
      .map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        level: String(r.level),
        event: r.event === null ? null : String(r.event),
        roomId: r.room_id === null ? null : String(r.room_id),
        msg: String(r.msg),
        detail: parseDetail(r.detail),
      }));
  }

  /** Por idade e por teto de linhas, em cada tabela. */
  prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const table of PRUNED_TABLES) {
      this.stmt(`DELETE FROM ${table} WHERE at < ?`).run(cutoff);
      this.stmt(
        `DELETE FROM ${table} WHERE id <= (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      ).run(MAX_ROWS);
    }
  }

  private stmt(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }
}

function parseDetail(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
