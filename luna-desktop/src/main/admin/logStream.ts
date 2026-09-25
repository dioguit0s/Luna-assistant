// Log ao vivo do servidor (GET /admin/v1/logs/stream, Server-Sent Events) para
// a tela Diagnóstico. Vive no processo principal pelo mesmo motivo do
// AdminClient: o token não atravessa para o painel, que só recebe as linhas.
//
// Um stream por vez — trocar o filtro fecha o anterior. Cai a conexão,
// reconecta sozinho com espera crescente até `stop()`. O servidor reenvia o
// passado recente a cada conexão; o `seq` descarta o que já foi entregue.
//
// Módulo puro (sem `electron`): testável com `node --test` e um fetch falso.

import { adminBaseUrl } from '../local-settings.js';
import type { AdminConnection } from './client.js';

export interface LogFilter {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  room: string | null;
}

export type LogStreamEvent =
  | { type: 'log'; record: unknown }
  | { type: 'log-status'; state: 'connecting' | 'open' | 'closed'; error: string | null };

const CONNECT_TIMEOUT_MS = 5_000;
/** O servidor manda `: ping` a cada 15 s; três perdidos = conexão morta. */
const IDLE_TIMEOUT_MS = 45_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export function validFilter(level: unknown, room: unknown): LogFilter {
  if (typeof level !== 'string' || !LEVELS.has(level)) throw new TypeError('nível de log inválido');
  if (room !== null && (typeof room !== 'string' || !/^[a-z0-9_]{1,64}$/.test(room))) {
    throw new TypeError('sala inválida');
  }
  return { level: level as LogFilter['level'], room: room as string | null };
}

export class LogStream {
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MIN_MS;
  private lastSeq = 0;
  private lastTs = 0;
  private generation = 0;

  constructor(
    private readonly connection: () => AdminConnection,
    private readonly emit: (event: LogStreamEvent) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {}

  start(filter: LogFilter): void {
    this.stop(false);
    this.lastSeq = 0;
    this.lastTs = 0;
    this.retryMs = RETRY_MIN_MS;
    void this.connect(filter, ++this.generation);
  }

  stop(announce = true): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
    if (announce) this.emit({ type: 'log-status', state: 'closed', error: null });
  }

  private async connect(filter: LogFilter, generation: number): Promise<void> {
    const { serverUrl, adminToken } = this.connection();
    if (!adminToken) {
      this.emit({ type: 'log-status', state: 'closed', error: 'Token admin não configurado.' });
      return;
    }
    let base: string;
    try {
      base = adminBaseUrl(serverUrl);
    } catch {
      this.emit({ type: 'log-status', state: 'closed', error: 'URL do servidor inválida.' });
      return;
    }

    const params = new URLSearchParams({ level: filter.level });
    if (filter.room) params.set('room', filter.room);
    const controller = new AbortController();
    this.controller = controller;
    this.emit({ type: 'log-status', state: 'connecting', error: null });

    // Timeout só até os cabeçalhos: o corpo é um stream sem fim.
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    let error: string | null = null;
    try {
      const res = await this.fetchImpl(`${base}/admin/v1/logs/stream?${params}`, {
        headers: { authorization: `Bearer ${adminToken}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `HTTP ${res.status}`;
        // 4xx não se resolve tentando de novo (token, filtro): para aqui.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          if (generation === this.generation) this.emit({ type: 'log-status', state: 'closed', error });
          return;
        }
      } else {
        this.emit({ type: 'log-status', state: 'open', error: null });
        this.retryMs = RETRY_MIN_MS;
        await this.pump(res.body, generation);
        error = 'conexão encerrada pelo servidor';
      }
    } catch (err) {
      clearTimeout(connectTimer);
      if (generation !== this.generation) return;
      error = err instanceof Error ? err.message : String(err);
    }

    if (generation !== this.generation) return;
    this.emit({ type: 'log-status', state: 'connecting', error });
    this.retryTimer = setTimeout(() => void this.connect(filter, generation), this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  private async pump(body: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Meio-aberto não fecha nem manda nada: sem isto a tela ficaria em
    // "AO VIVO" para sempre. Qualquer byte (linha ou ping) rearma.
    let idle: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => this.controller?.abort(), this.idleTimeoutMs);
    };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || generation !== this.generation) return;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          this.handleBlock(block);
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
  }

  private handleBlock(block: string): void {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (!data) return;
    let record: { seq?: unknown; ts?: unknown };
    try {
      record = JSON.parse(data) as { seq?: unknown; ts?: unknown };
    } catch {
      return;
    }
    const seq = typeof record.seq === 'number' ? record.seq : 0;
    const ts = typeof record.ts === 'number' ? record.ts : 0;
    // Reconexão reenvia o passado recente; o que já saiu não repete. Depois de
    // o servidor reiniciar o `seq` recomeça do zero, mas o horário segue à
    // frente — é o que deixa a linha nova passar.
    if (seq <= this.lastSeq && ts <= this.lastTs) return;
    this.lastSeq = seq;
    this.lastTs = Math.max(this.lastTs, ts);
    this.emit({ type: 'log', record });
  }
}
