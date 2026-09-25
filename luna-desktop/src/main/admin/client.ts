// Cliente da API admin do luna-server (ADR 010, /admin/v1/*). Vive no
// processo principal: o token nunca atravessa para a janela do painel, que só
// recebe o corpo JSON das respostas.
//
// Módulo puro (sem `electron`): testável com `node --test` e um fetch falso.

import { adminBaseUrl } from '../local-settings.js';

const REQUEST_TIMEOUT_MS = 5_000;

export interface AdminResult {
  ok: boolean;
  status: number;
  /** Corpo JSON da resposta, ou `{ error }` montado aqui quando nem houve resposta. */
  body: unknown;
}

export interface AdminConnection {
  serverUrl: string;
  adminToken: string;
}

export class AdminClient {
  constructor(
    private readonly connection: () => AdminConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Nunca lança: erro de rede, timeout e status HTTP viram `ok: false` com uma
   * mensagem em português que o painel mostra direto.
   */
  async request(method: string, path: string, body?: unknown): Promise<AdminResult> {
    const { serverUrl, adminToken } = this.connection();
    if (!adminToken) {
      return {
        ok: false,
        status: 0,
        body: { error: 'Token admin não configurado — preencha em Este computador.' },
      };
    }

    let base: string;
    try {
      base = adminBaseUrl(serverUrl);
    } catch {
      return { ok: false, status: 0, body: { error: 'URL do servidor inválida.' } };
    }

    try {
      const res = await this.fetchImpl(`${base}/admin/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: `resposta não-JSON (HTTP ${res.status})` };
      }
      if (!res.ok) return { ok: false, status: res.status, body: explain(res.status, parsed) };
      return { ok: true, status: res.status, body: parsed };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        ok: false,
        status: 0,
        body: {
          // Distingue "servidor fora do ar" de configuração faltando (também
          // status 0): o painel mostra a tela SEM SINAL só no primeiro caso.
          offline: true,
          error: timedOut
            ? `Servidor não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s.`
            : `Servidor inacessível (${err instanceof Error ? err.message : String(err)}).`,
        },
      };
    }
  }
}

/** Troca os status que o usuário resolve sozinho por uma instrução, mantendo `field`. */
function explain(status: number, body: unknown): unknown {
  const original = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const hints: Record<number, string> = {
    401: 'Token admin recusado pelo servidor — confira o LUNA_ADMIN_TOKEN.',
    403: 'O servidor só aceita o painel de dentro da rede local.',
    404:
      typeof original.error === 'string'
        ? original.error
        : 'API admin desligada no servidor (LUNA_ADMIN_TOKEN ausente) ou servidor antigo.',
  };
  return { ...original, error: hints[status] ?? original.error ?? `HTTP ${status}` };
}
