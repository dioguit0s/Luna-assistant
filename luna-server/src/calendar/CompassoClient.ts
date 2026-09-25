import { getLogger } from '../logging/logger.js';

/**
 * Cliente HTTP da API do Compasso (o app de agendas), `/api/v1`.
 *
 * A conexão é lida a cada requisição, não capturada na construção: trocar URL
 * ou token pelo painel vale na hora, sem *holder* extra (ADR 010, decisão 5).
 *
 * Nunca lança. Todo desfecho vira `CompassoResult`, e toda falha já carrega
 * uma frase falável — o handler da tool só repassa. Decisão por `error.code`,
 * nunca pelo texto da mensagem, como o guia do Compasso pede.
 *
 * O token nunca entra em log.
 */

export interface CompassoConnection {
  /** Base já com `/api/v1`, ex.: `http://127.0.0.1:8090/api/v1`. */
  url: string;
  token: string;
}

/** Os `error.code` que o Compasso documenta, mais os dois que nascem aqui. */
export type CompassoErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'
  /** Timeout ou erro de rede: nenhuma resposta chegou. */
  | 'unreachable'
  /** Resposta que não é o JSON do contrato. */
  | 'bad_response'
  /** URL ou token vazios, ou URL inválida: nem tentou a rede. */
  | 'not_configured';

export type CompassoResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; code: CompassoErrorCode; message: string; field: string | null };

interface BaseItem {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  location: string | null;
  recurring: boolean;
  occurrence_date: string | null;
}

export interface CompassoEvent extends BaseItem {
  type: 'event';
}

export interface CompassoClass extends BaseItem {
  type: 'class';
  subject: string | null;
  professor: string | null;
  cancelled: boolean;
}

export interface CompassoTask extends BaseItem {
  type: 'task';
  due: string | null;
  done: boolean;
}

export type CompassoItem = CompassoEvent | CompassoClass | CompassoTask;

export interface CompassoList {
  timezone: string;
  items: CompassoItem[];
  next_cursor: string | null;
}

export interface CreatedEvent extends CompassoEvent {
  /** Eventos com horário e aulas que se sobrepõem. O evento é criado mesmo assim. */
  conflicts?: CompassoItem[];
}

export const TASK_EFFORTS = [1, 2, 3, 5, 8] as const;
export const TASK_ATTRIBUTES = ['corpo', 'mente', 'oficio', 'casa', 'social'] as const;
export type TaskAttribute = (typeof TASK_ATTRIBUTES)[number];

export interface CreateTaskBody {
  title: string;
  effort: number;
  attribute: TaskAttribute;
  due?: string;
}

export interface CreateEventBody {
  title: string;
  start: string;
  end?: string;
  duration_minutes?: number;
  all_day?: boolean;
}

/** Timeouts do guia: 3 s no health, 2 s no resto. */
const HEALTH_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 2000;

/** Mensagem do Compasso repassada à voz: curta por contrato, mas é dado externo. */
const MAX_SPOKEN_MESSAGE = 160;

const SPOKEN: Record<Exclude<CompassoErrorCode, 'validation_error' | 'not_found'>, string> = {
  unauthorized: 'a integração com o Compasso precisa de um token novo',
  forbidden: 'não tenho permissão para mexer no Compasso',
  conflict: 'o Compasso recusou o pedido repetido',
  rate_limited: 'o Compasso pediu para esperar um pouco',
  internal: 'o Compasso falhou agora',
  unreachable: 'o Compasso não respondeu agora',
  bad_response: 'o Compasso respondeu algo que eu não entendi',
  not_configured: 'a agenda não está configurada',
};

const KNOWN_CODES = new Set<string>([
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
]);

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  /**
   * Uma nova tentativa em timeout, erro de rede ou 500. Só para escrita com
   * `Idempotency-Key` ou idempotente por natureza (concluir tarefa): o guia
   * garante que repetir não duplica. Leitura não repete — o turno de voz não
   * tem orçamento para duas esperas de 2 s.
   */
  retry?: boolean;
}

export interface CompassoStatus {
  ok: boolean;
  at: number;
  error: string | null;
}

export class CompassoClient {
  private last: CompassoStatus | null = null;

  constructor(
    private readonly connection: () => CompassoConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** URL e token presentes: é o que liga as tools da agenda. */
  get configured(): boolean {
    const { url, token } = this.connection();
    return url.trim() !== '' && token.trim() !== '';
  }

  /**
   * Conexão trocada pelo painel: o desfecho antigo (ex.: token revogado) não
   * diz nada sobre a nova e deixaria o semáforo vermelho até a próxima fala.
   */
  resetStatus(): void {
    this.last = null;
  }

  /** Desfecho da última chamada, para o semáforo do painel. */
  lastStatus(): CompassoStatus | null {
    return this.last ? { ...this.last } : null;
  }

  health(conn?: CompassoConnection): Promise<CompassoResult<{ ok: boolean; version?: string }>> {
    return this.request('GET', '/health', { timeoutMs: HEALTH_TIMEOUT_MS }, conn);
  }

  agenda(params: {
    from: string;
    to: string;
    types?: string;
    q?: string;
    limit?: number;
  }): Promise<CompassoResult<CompassoList>> {
    return this.request('GET', '/agenda', {
      query: {
        from: params.from,
        to: params.to,
        types: params.types,
        q: params.q,
        limit: params.limit === undefined ? undefined : String(params.limit),
      },
    });
  }

  pendingTasks(params: { q?: string; limit?: number } = {}): Promise<CompassoResult<CompassoList>> {
    return this.request('GET', '/tasks', {
      query: {
        done: 'false',
        q: params.q,
        limit: params.limit === undefined ? undefined : String(params.limit),
      },
    });
  }

  createTask(body: CreateTaskBody, idempotencyKey: string): Promise<CompassoResult<CompassoTask>> {
    return this.request('POST', '/tasks', { body, idempotencyKey, retry: true });
  }

  createEvent(body: CreateEventBody, idempotencyKey: string): Promise<CompassoResult<CreatedEvent>> {
    return this.request('POST', '/events', { body, idempotencyKey, retry: true });
  }

  completeTask(id: string, occurrenceDate?: string): Promise<CompassoResult<CompassoTask>> {
    return this.request('POST', `/tasks/${encodeURIComponent(id)}/complete`, {
      body: occurrenceDate ? { occurrence_date: occurrenceDate } : undefined,
      retry: true,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions,
    override?: CompassoConnection,
  ): Promise<CompassoResult<T>> {
    const conn = override ?? this.connection();
    const base = conn.url.trim().replace(/\/+$/, '');
    if (!base || !conn.token.trim()) {
      return fail(null, 'not_configured', SPOKEN.not_configured, null);
    }

    let url: URL;
    try {
      url = new URL(`${base}${path}`);
    } catch {
      // O "testar" do painel manda a URL crua do formulário, sem o `httpUrl`
      // que valida a gravada.
      return fail(null, 'not_configured', 'o endereço da agenda é inválido', null);
    }
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${conn.token.trim()}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const attempts = opts.retry ? 2 : 1;
    let result: CompassoResult<T> = fail(null, 'unreachable', SPOKEN.unreachable, null);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const startedAt = Date.now();
      result = await this.once<T>(method, url, headers, opts);
      getLogger().info(
        {
          event: 'calendar_request',
          method,
          // Só o caminho: a query leva o texto da busca, que é fala do usuário.
          path,
          attempt,
          status: result.status,
          ok: result.ok,
          ...(result.ok ? {} : { code: result.code }),
          latency_ms: Date.now() - startedAt,
        },
        `Compasso ${method} ${path} → ${result.status ?? 'sem resposta'}`,
      );
      const retriable = !result.ok && (result.code === 'unreachable' || result.code === 'internal');
      if (!retriable) break;
    }

    // Só o health de outra conexão (o "testar" do painel antes de salvar) não
    // diz nada sobre a conexão gravada.
    if (!override) {
      this.last = { ok: result.ok, at: Date.now(), error: result.ok ? null : result.message };
    }
    return result;
  }

  private async once<T>(
    method: 'GET' | 'POST',
    url: URL,
    headers: Record<string, string>,
    opts: RequestOptions,
  ): Promise<CompassoResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      return fail(null, 'unreachable', SPOKEN.unreachable, null);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }

    if (res.ok) {
      if (typeof payload !== 'object' || payload === null) {
        return fail(res.status, 'bad_response', SPOKEN.bad_response, null);
      }
      return { ok: true, status: res.status, data: payload as T };
    }

    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? ((payload as { error: unknown }).error as Record<string, unknown> | null)
        : null;
    const rawCode = typeof error?.code === 'string' ? error.code : '';
    const code: CompassoErrorCode = KNOWN_CODES.has(rawCode)
      ? (rawCode as CompassoErrorCode)
      : codeFromStatus(res.status);
    const field = typeof error?.field === 'string' ? error.field : null;

    // Validação e "não encontrei" são as duas em que a frase do Compasso diz
    // mais que a nossa; nas outras, a nossa é a que sabe o que fazer.
    const message =
      (code === 'validation_error' || code === 'not_found') && typeof error?.message === 'string'
        ? cleanText(error.message, MAX_SPOKEN_MESSAGE) ||
          (code === 'not_found' ? 'não encontrei esse item' : 'o Compasso recusou o pedido')
        : code === 'validation_error'
          ? 'o Compasso recusou o pedido'
          : code === 'not_found'
            ? 'não encontrei esse item'
            : SPOKEN[code];

    return fail(res.status, code, message, field);
  }
}

function codeFromStatus(status: number): CompassoErrorCode {
  if (status === 400 || status === 422) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'bad_response';
}

function fail(
  status: number | null,
  code: CompassoErrorCode,
  message: string,
  field: string | null,
): CompassoResult<never> {
  return { ok: false, status, code, message, field };
}

/**
 * Texto vindo do Compasso a caminho do modelo: sem caractere de controle, sem
 * quebra de linha, com teto. Título de evento é dado externo que vira contexto
 * da sessão — não pode trazer um parágrafo nem formatação que se passe por
 * instrução.
 */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
