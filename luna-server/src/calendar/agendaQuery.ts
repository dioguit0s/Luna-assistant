import type { CompassoClient, CompassoItem, CompassoList, CompassoResult } from './CompassoClient.js';
import { cleanText } from './CompassoClient.js';
import { resolveRange } from './dates.js';
import { describeItem, type SpokenItem } from './spoken.js';
import type { AgendaKind, GetAgendaArgs } from './tools.js';

/**
 * Montagem do resultado de `get_agenda`, num lugar só: a tool de voz e a tela
 * "O que a Luna vê hoje" do painel chamam esta função, e o painel mostra
 * exatamente o `payload` que o modelo receberia. Reimplementar a consulta na
 * rota admin faria a tela mentir no dia em que uma das duas mudasse.
 *
 * Sem log e sem contexto de sessão: quem chama decide o que registrar.
 */

/**
 * Teto de itens entregues ao modelo. Uma semana cheia pode ter 40 itens; a
 * Luna fala 1-2 frases, e cada item a mais é orçamento de contexto e latência
 * de geração. O resto vira `more`, e o prompt manda estreitar a consulta (um
 * dia, um tipo) — não há cursor nos args, então repetir traria o mesmo.
 */
export const MAX_SPOKEN_ITEMS = 15;

/** Uma página só: seguir `next_cursor` custaria outra ida de até 2 s no turno. */
const PAGE_LIMIT = 50;

const TYPES_BY_KIND: Record<Exclude<AgendaKind, 'pending_tasks'>, string | undefined> = {
  all: undefined,
  events: 'event',
  classes: 'class',
  tasks: 'task',
};

/** O que `get_agenda` devolve ao modelo. */
export type AgendaPayload =
  | { success: true; period: string; items: SpokenItem[]; more?: true }
  | { success: false; error: string };

export type AgendaQueryOutcome =
  | {
      ok: true;
      payload: AgendaPayload & { success: true };
      period: string;
      multiDay: boolean;
      /** Tudo que o Compasso devolveu, antes do teto — o painel mostra o que ficou de fora. */
      items: CompassoItem[];
      latencyMs: number;
    }
  | {
      ok: false;
      payload: AgendaPayload & { success: false };
      /** `error.code` do Compasso, `not_configured` ou `invalid_range` (args fora da semântica). */
      code: string;
      /** `null` quando nem chegou a chamar o Compasso. */
      latencyMs: number | null;
    };

/** `args` já passou por `isGetAgendaArgs`. */
export async function queryAgenda(
  client: Pick<CompassoClient, 'configured' | 'agenda' | 'pendingTasks'>,
  args: GetAgendaArgs,
  agora: Date,
): Promise<AgendaQueryOutcome> {
  if (!client.configured) {
    return {
      ok: false,
      payload: { success: false, error: 'a agenda não está configurada' },
      code: 'not_configured',
      latencyMs: null,
    };
  }

  const kind: AgendaKind = args.kind ?? 'all';
  const search = cleanText(args.search, 100) || undefined;

  let period: string;
  let multiDay: boolean;
  let result: CompassoResult<CompassoList>;
  let startedAt: number;
  if (kind === 'pending_tasks') {
    period = 'tarefas pendentes';
    multiDay = true;
    startedAt = performance.now();
    result = await client.pendingTasks({ q: search, limit: PAGE_LIMIT });
  } else {
    const range = resolveRange(
      {
        // Busca sem período procura nos próximos meses; com "dia 30", só nele.
        when: args.when ?? (search && args.day_of_month === undefined ? 'upcoming' : undefined),
        dayOfMonth: args.day_of_month,
      },
      agora,
    );
    if (!range.ok) {
      return { ok: false, payload: { success: false, error: range.error }, code: 'invalid_range', latencyMs: null };
    }
    period = range.range.spoken;
    multiDay = range.range.multiDay;
    startedAt = performance.now();
    result = await client.agenda({
      from: range.range.from,
      to: range.range.to,
      types: TYPES_BY_KIND[kind],
      q: search,
      limit: PAGE_LIMIT,
    });
  }
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!result.ok) {
    return { ok: false, payload: { success: false, error: result.message }, code: result.code, latencyMs };
  }

  const data: CompassoList = result.data;
  const items = Array.isArray(data.items) ? data.items : [];
  const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map((item) => describeItem(item, agora, multiDay));
  const more = items.length > spoken.length || Boolean(data.next_cursor);

  return {
    ok: true,
    payload: { success: true, period, items: spoken, ...(more ? { more: true as const } : {}) },
    period,
    multiDay,
    items,
    latencyMs,
  };
}
