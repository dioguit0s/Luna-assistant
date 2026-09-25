import { LEVEL_VALUES, subscribeLogs, type LogLevelName, type LogRecord } from '../logging/logTap.js';
import type { DiagnosticsStore } from './DiagnosticsStore.js';

/**
 * Diagnóstico do painel (v2), alimentado só pelo log (`logTap.ts`) — nenhum
 * ponto de negócio sabe que ele existe:
 *
 * - `event: 'ttfab'` vira amostra na série de latência;
 * - `error`/`fatal`, e os `warn` de dependência externa que falhou, viram
 *   entrada em "últimos erros";
 * - tudo entra num buffer circular em memória, que é o "passado recente" do
 *   log ao vivo quando o painel abre o stream.
 */

/** `warn` que o painel trata como erro: HA, provider, clima ou lembrete que falhou. */
const WARN_AS_ERROR = new Set([
  'ha_verify',
  'ha_get_state',
  'ha_list_entities',
  'ha_not_configured',
  'device_registry_refresh',
  'weather_fetch',
  'weather_refresh',
  'gemini_session_closed',
  'reminder_missed',
  'alarm_missed',
  'speaking_watchdog',
]);

export const LIVE_BUFFER_SIZE = 500;

export interface LogFilter {
  minLevel: LogLevelName;
  roomId: string | null;
}

export function matchesFilter(record: LogRecord, filter: LogFilter): boolean {
  if (record.levelValue < LEVEL_VALUES[filter.minLevel]) return false;
  if (filter.roomId !== null && record.roomId !== filter.roomId) return false;
  return true;
}

export class Diagnostics {
  private readonly buffer: LogRecord[] = [];
  private readonly listeners = new Set<(record: LogRecord) => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(readonly store: DiagnosticsStore) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeLogs((record) => this.ingest(record));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /** Público para teste; em produção só o tap chama. */
  ingest(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > LIVE_BUFFER_SIZE) this.buffer.shift();

    // Falha de SQLite aqui não pode virar log de erro: o tap descarta
    // reentrância, então logar seria só perder a linha. Engolir é o certo — o
    // diagnóstico é best effort, o log em si já saiu.
    try {
      if (record.event === 'ttfab') this.recordLatency(record);
      if (record.levelValue >= LEVEL_VALUES.error || (record.event !== null && record.levelValue >= LEVEL_VALUES.warn && WARN_AS_ERROR.has(record.event))) {
        this.store.insertError({
          at: record.ts,
          level: record.level,
          event: record.event,
          roomId: record.roomId,
          msg: record.msg,
          detail: Object.keys(record.fields).length > 0 ? record.fields : null,
        });
      }
    } catch {
      // ver acima
    }

    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // um stream quebrado não afeta os outros
      }
    }
  }

  /** O que o buffer tem e passa no filtro, mais antigo primeiro. */
  recent(filter: LogFilter, limit = 200): LogRecord[] {
    const matching = this.buffer.filter((r) => matchesFilter(r, filter));
    return matching.slice(-limit);
  }

  onRecord(listener: (record: LogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get streamCount(): number {
    return this.listeners.size;
  }

  private recordLatency(record: LogRecord): void {
    const f = record.fields;
    if (typeof f.latency_ms !== 'number' || record.roomId === null) return;
    this.store.insertLatency({
      at: record.ts,
      roomId: record.roomId,
      deviceId: typeof f.device_id === 'string' ? f.device_id : null,
      provider: typeof f.provider === 'string' ? f.provider : 'desconhecido',
      latencyMs: f.latency_ms,
      sinceTurnStartMs: typeof f.since_turn_start_ms === 'number' ? f.since_turn_start_ms : null,
      providerWaitMs: typeof f.provider_wait_ms === 'number' ? f.provider_wait_ms : null,
      sessionCold: f.session_cold === true,
    });
  }
}
