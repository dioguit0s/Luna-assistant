import type { CompassoClient, CompassoList, CompassoResult } from '../../calendar/CompassoClient.js';
import { cleanText } from '../../calendar/CompassoClient.js';
import { resolveRange } from '../../calendar/dates.js';
import { describeItem } from '../../calendar/spoken.js';
import { isGetAgendaArgs, type AgendaKind } from '../../calendar/tools.js';
import { getLogger } from '../../logging/logger.js';
import type { NowFn } from '../../time/clock.js';
import { systemNow } from '../../time/clock.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

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

export interface GetAgendaDeps {
  client: CompassoClient;
  now?: NowFn;
}

/**
 * Handler de `get_agenda`. Diferente do `get_weather`, faz I/O no caminho
 * fala→resposta: agenda muda por fora (o usuário edita no app) e um cache
 * responderia "nada hoje" logo depois de ele ter marcado algo. O Compasso roda
 * na LAN — o mesmo argumento que torna aceitável o `await` do HA em
 * `controlDevice.ts` — com timeout de 2 s e sem nova tentativa em leitura.
 */
export function createGetAgendaHandler(deps: GetAgendaDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    if (!isGetAgendaArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'get_agenda', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    if (!deps.client.configured) {
      return { success: false, error: 'a agenda não está configurada' };
    }

    const agora = now();
    const kind: AgendaKind = args.kind ?? 'all';
    const search = cleanText(args.search, 100) || undefined;

    let period: string;
    let multiDay: boolean;
    let result: CompassoResult<CompassoList>;
    if (kind === 'pending_tasks') {
      period = 'tarefas pendentes';
      multiDay = true;
      result = await deps.client.pendingTasks({ q: search, limit: PAGE_LIMIT });
    } else {
      const range = resolveRange(
        {
          // Busca sem período procura nos próximos meses; com "dia 30", só nele.
          when: args.when ?? (search && args.day_of_month === undefined ? 'upcoming' : undefined),
          dayOfMonth: args.day_of_month,
        },
        agora,
      );
      if (!range.ok) return { success: false, error: range.error };
      period = range.range.spoken;
      multiDay = range.range.multiDay;
      result = await deps.client.agenda({
        from: range.range.from,
        to: range.range.to,
        types: TYPES_BY_KIND[kind],
        q: search,
        limit: PAGE_LIMIT,
      });
    }

    if (!result.ok) {
      getLogger().warn(
        { event: 'calendar_query_failed', room_id: ctx.roomId, kind, code: result.code },
        `Consulta à agenda falhou: ${result.code}`,
      );
      return { success: false, error: result.message };
    }

    const data: CompassoList = result.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map((item) => describeItem(item, agora, multiDay));
    const more = items.length > spoken.length || Boolean(data.next_cursor);

    getLogger().info(
      {
        event: 'calendar_query',
        room_id: ctx.roomId,
        kind,
        when: args.when ?? null,
        has_search: search !== undefined,
        count: items.length,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `Agenda consultada: ${items.length} itens (${period})`,
    );

    return {
      success: true,
      period,
      items: spoken,
      ...(more ? { more: true } : {}),
    };
  };
}
