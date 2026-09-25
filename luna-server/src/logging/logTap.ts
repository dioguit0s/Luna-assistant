/**
 * Cópia de cada linha de log para quem estiver ouvindo dentro do processo —
 * o diagnóstico do painel (log ao vivo, últimos erros, série de TTFAB) sem
 * tocar nos pontos que logam. Alimentado pelo hook `logMethod` do pino em
 * `logger.ts`, então só vê o que o `LOG_LEVEL` deixa passar.
 *
 * **Sem transcrição** (decisão de produto do painel): o registro leva só campos
 * escalares, e cai fora qualquer chave que possa carregar o que foi dito —
 * `raw` do `GEMINI_DEBUG_MESSAGES`, texto, transcrição, prompt.
 */

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogRecord {
  /** Crescente dentro do processo: o painel usa para não repetir linha. */
  seq: number;
  ts: number;
  level: LogLevelName;
  levelValue: number;
  event: string | null;
  roomId: string | null;
  msg: string;
  fields: Record<string, string | number | boolean | null>;
}

export type LogListener = (record: LogRecord) => void;

const LEVEL_NAMES: Record<number, LogLevelName> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export const LEVEL_VALUES: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Chaves que podem carregar fala do usuário ou da Luna. */
const DENIED_KEY = /raw|transcri|text|prompt|speech|utterance/i;
const MAX_STRING = 200;
const MAX_FIELDS = 24;

const listeners = new Set<LogListener>();
let seq = 0;
/** Um listener que loga não pode voltar para cá e entrar em laço. */
let emitting = false;

export function subscribeLogs(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Chamado pelo hook do pino com os argumentos crus da chamada:
 * `(obj, msg)`, `(msg)` ou `(err, msg)`. Nunca lança — o log não pode cair
 * por causa do diagnóstico.
 */
export function emitLog(levelValue: number, args: readonly unknown[]): void {
  if (listeners.size === 0 || emitting) return;
  emitting = true;
  try {
    const record = toRecord(levelValue, args);
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // Um ouvinte quebrado não derruba os outros nem o log.
      }
    }
  } catch {
    // Idem: registro malformado é descartado em silêncio.
  } finally {
    emitting = false;
  }
}

function toRecord(levelValue: number, args: readonly unknown[]): LogRecord {
  const [first, second] = args;
  let obj: Record<string, unknown> = {};
  let msg = '';
  if (first instanceof Error) {
    obj = { err: first.message };
    msg = typeof second === 'string' ? second : first.message;
  } else if (typeof first === 'object' && first !== null) {
    obj = first as Record<string, unknown>;
    msg = typeof second === 'string' ? second : '';
  } else if (typeof first === 'string') {
    msg = first;
  }

  const fields: LogRecord['fields'] = {};
  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (count >= MAX_FIELDS) break;
    if (key === 'event' || DENIED_KEY.test(key)) continue;
    const scalar = toScalar(value);
    if (scalar === undefined) continue;
    fields[key] = scalar;
    count += 1;
  }

  return {
    seq: ++seq,
    ts: Date.now(),
    level: LEVEL_NAMES[levelValue] ?? 'info',
    levelValue,
    event: typeof obj.event === 'string' ? obj.event : null,
    roomId: typeof obj.room_id === 'string' ? obj.room_id : null,
    msg: msg.slice(0, MAX_STRING),
    fields,
  };
}

function toScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (value instanceof Error) return value.message.slice(0, MAX_STRING);
  return undefined;
}

/** Só para testes: zera ouvintes entre casos. */
export function resetLogTapForTests(): void {
  listeners.clear();
}
