import type { CompassoClient } from '../../calendar/CompassoClient.js';
import { cleanText } from '../../calendar/CompassoClient.js';
import { loggableInt, type AgendaEventSink, type AgendaLogEntry } from '../../calendar/agendaLog.js';
import { queryAgenda } from '../../calendar/agendaQuery.js';
import { isGetAgendaArgs, type AgendaKind, type GetAgendaArgs } from '../../calendar/tools.js';
import { getLogger } from '../../logging/logger.js';
import type { NowFn } from '../../time/clock.js';
import { systemNow } from '../../time/clock.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

export { MAX_SPOKEN_ITEMS } from '../../calendar/agendaQuery.js';

export interface GetAgendaDeps {
  client: CompassoClient;
  now?: NowFn;
  /** Histórico do painel. Ausente nos testes que não olham para ele. */
  log?: AgendaEventSink | null;
}

/**
 * Handler de `get_agenda`. Diferente do `get_weather`, faz I/O no caminho
 * fala→resposta: agenda muda por fora (o usuário edita no app) e um cache
 * responderia "nada hoje" logo depois de ele ter marcado algo. O Compasso roda
 * na LAN — o mesmo argumento que torna aceitável o `await` do HA em
 * `controlDevice.ts` — com timeout de 2 s e sem nova tentativa em leitura.
 *
 * A montagem do resultado é `queryAgenda`, a mesma que a tela "O que a Luna vê
 * hoje" do painel usa.
 */
export function createGetAgendaHandler(deps: GetAgendaDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    const base = (): Omit<AgendaLogEntry, 'result' | 'itemCount' | 'latencyMs'> => ({
      at: now().getTime(),
      roomId: ctx.roomId,
      tool: 'get_agenda',
      action: 'query',
      when: null,
      dayOfMonth: null,
      kind: null,
      effort: null,
      attribute: null,
      hasSearch: false,
      itemId: null,
    });

    if (!isGetAgendaArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'get_agenda', args },
        'Tool call inválida ou desconhecida',
      );
      deps.log?.record({ ...base(), result: 'invalid_args', itemCount: null, latencyMs: null });
      return INVALID_ARGS_RESULT;
    }

    const agora = now();
    const kind: AgendaKind = args.kind ?? 'all';
    const hasSearch = cleanText(args.search, 100) !== '';
    const params = { ...base(), ...loggedParams(args), at: agora.getTime(), hasSearch };

    const outcome = await queryAgenda(deps.client, args, agora);

    if (!outcome.ok) {
      deps.log?.record({ ...params, result: outcome.code, itemCount: null, latencyMs: outcome.latencyMs });
      if (outcome.code !== 'not_configured' && outcome.code !== 'invalid_range') {
        getLogger().warn(
          { event: 'calendar_query_failed', room_id: ctx.roomId, kind, code: outcome.code },
          `Consulta à agenda falhou: ${outcome.code}`,
        );
      }
      return outcome.payload;
    }

    deps.log?.record({ ...params, result: 'ok', itemCount: outcome.items.length, latencyMs: outcome.latencyMs });
    getLogger().info(
      {
        event: 'calendar_query',
        room_id: ctx.roomId,
        kind,
        when: args.when ?? null,
        has_search: hasSearch,
        count: outcome.items.length,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `Agenda consultada: ${outcome.items.length} itens (${outcome.period})`,
    );

    return outcome.payload;
  };
}

function loggedParams(args: GetAgendaArgs): Pick<AgendaLogEntry, 'when' | 'dayOfMonth' | 'kind'> {
  return {
    when: args.when ?? null,
    dayOfMonth: loggableInt(args.day_of_month, 1, 31),
    kind: args.kind ?? null,
  };
}
