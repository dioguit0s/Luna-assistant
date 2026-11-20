import type {
  CompassoClient,
  CompassoItem,
  CompassoTask,
  CreateEventBody,
  CreateTaskBody,
} from '../../calendar/CompassoClient.js';
import { TASK_EFFORTS, cleanText } from '../../calendar/CompassoClient.js';
import { loggableInt, type AgendaEventSink } from '../../calendar/agendaLog.js';
import { dateAtOffset, dateTimeIso, resolveDay, spokenDate, splitIso, startOfDayIso } from '../../calendar/dates.js';
import { describeItem } from '../../calendar/spoken.js';
import { AGENDA_ACTIONS, isManageAgendaArgs, type AgendaAction, type ManageAgendaArgs } from '../../calendar/tools.js';
import { getLogger } from '../../logging/logger.js';
import type { NowFn } from '../../time/clock.js';
import { systemNow } from '../../time/clock.js';
import { INVALID_ARGS_RESULT, type ToolContext, type ToolHandler } from './types.js';

/** Teto de título do contrato do Compasso. */
const MAX_TITLE = 200;

/** Um "reunião de 900 horas" alucinado vira o extremo razoável, como o `in_seconds` dos lembretes. */
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 12 * 60;

/** Quantas tarefas parecidas a Luna lê para a pessoa escolher. */
const MAX_CANDIDATES = 5;

/** Tarefa recorrente só aparece na agenda, não em `/tasks`: procura nesta janela. */
const RECURRING_LOOKUP_DAYS = 7;

export interface ManageAgendaDeps {
  client: CompassoClient;
  now?: NowFn;
  /** Histórico do painel. Ausente nos testes que não olham para ele. */
  log?: AgendaEventSink | null;
}

type Result = Record<string, unknown>;

/** O que cada ação devolve: a resposta falável e o que vai para o histórico. */
interface Outcome {
  result: Result;
  /** `ok`, o `error.code` do Compasso ou um motivo fixo deste lado (`missing_effort`, `ambiguous`...). */
  code: string;
  itemId?: string | null;
  itemCount?: number | null;
}

/** Só os métodos que a escrita usa — o que `timed` embrulha. */
type AgendaWriteClient = Pick<CompassoClient, 'agenda' | 'pendingTasks' | 'createTask' | 'createEvent' | 'completeTask'>;

function ok(result: Result, itemId: string | null): Outcome {
  return { result: { success: true, ...result }, code: 'ok', itemId };
}

function fail(code: string, error: string, extra: Result = {}): Outcome {
  return { result: { success: false, error, ...extra }, code };
}

/**
 * Handler de `manage_agenda`: criar evento, criar tarefa, concluir tarefa.
 *
 * A confirmação devolvida vem da **resposta** do Compasso, não do pedido: é o
 * que foi gravado que a Luna fala (mesma regra do `spoken_when` dos lembretes).
 */
export function createManageAgendaHandler(deps: ManageAgendaDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    const agora = now();
    const entry = { at: agora.getTime(), roomId: ctx.roomId, tool: 'manage_agenda' as const, hasSearch: false, kind: null };

    if (!isManageAgendaArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'manage_agenda', args },
        'Tool call inválida ou desconhecida',
      );
      // Nenhum parâmetro: o que não passou no guard nem é do enum.
      deps.log?.record({
        ...entry,
        action: (AGENDA_ACTIONS as readonly unknown[]).includes(args.action) ? (args.action as AgendaAction) : null,
        when: null,
        dayOfMonth: null,
        effort: null,
        attribute: null,
        result: 'invalid_args',
        itemCount: null,
        itemId: null,
        latencyMs: null,
      });
      return INVALID_ARGS_RESULT;
    }

    const params = {
      ...entry,
      action: args.action,
      when: args.when_day ?? null,
      dayOfMonth: loggableInt(args.day_of_month, 1, 31),
      // Qualquer inteiro: um `effort: 4` recusado é justamente o que interessa ver.
      effort: loggableInt(args.effort, 0, 1000),
      attribute: args.attribute ?? null,
    };

    if (!deps.client.configured) {
      deps.log?.record({ ...params, result: 'not_configured', itemCount: null, itemId: null, latencyMs: null });
      return { success: false, error: 'a agenda não está configurada' };
    }

    const meter = timed(deps.client);
    let outcome: Outcome;
    switch (args.action) {
      case 'create_event':
        outcome = await createEvent(meter.client, args, ctx, agora);
        break;
      case 'create_task':
        outcome = await createTask(meter.client, args, ctx, agora);
        break;
      case 'complete_task':
        outcome = await completeTask(meter.client, args, agora);
        break;
    }

    deps.log?.record({
      ...params,
      result: outcome.code,
      itemCount: outcome.itemCount ?? null,
      itemId: outcome.itemId ?? null,
      latencyMs: meter.elapsed(),
    });
    getLogger().info(
      {
        event: 'calendar_write',
        room_id: ctx.roomId,
        action: args.action,
        success: outcome.code === 'ok',
        code: outcome.code,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `Agenda: ${args.action} ${outcome.code === 'ok' ? 'ok' : 'falhou'}`,
    );
    return outcome.result;
  };
}

/**
 * Cliente que soma o tempo das idas ao Compasso: concluir por nome pode fazer
 * três (pendentes, agenda, concluir), e a latência do histórico é a da ação
 * inteira, sem o tempo de validação deste lado.
 */
function timed(client: CompassoClient): { client: AgendaWriteClient; elapsed(): number | null } {
  let total = 0;
  let calls = 0;
  // O método é buscado na hora da chamada, não na construção: o embrulho não
  // exige que o client tenha os cinco (os fakes dos testes têm só o que usam).
  const wrap = <K extends keyof AgendaWriteClient>(name: K): AgendaWriteClient[K] =>
    (async (...a: unknown[]) => {
      const startedAt = performance.now();
      try {
        return await (client[name] as (...x: unknown[]) => Promise<unknown>).apply(client, a);
      } finally {
        total += performance.now() - startedAt;
        calls += 1;
      }
    }) as AgendaWriteClient[K];
  return {
    client: {
      agenda: wrap('agenda'),
      pendingTasks: wrap('pendingTasks'),
      createTask: wrap('createTask'),
      createEvent: wrap('createEvent'),
      completeTask: wrap('completeTask'),
    },
    elapsed: () => (calls > 0 ? Math.round(total) : null),
  };
}

/**
 * Uma chave por intenção, como o guia do Compasso pede: o `callId` é único por
 * invocação do modelo, e a nova tentativa do `CompassoClient` (timeout, 500)
 * reusa a mesma chave — o Compasso devolve o item já criado em vez de duplicar.
 */
function idempotencyKey(ctx: ToolContext, action: string): string {
  return `luna:${ctx.roomId}:${action}:${ctx.callId}`;
}

function titleOf(args: ManageAgendaArgs): { ok: true; title: string } | { ok: false; outcome: Outcome } {
  const title = cleanText(args.title, Number.MAX_SAFE_INTEGER);
  if (!title) return { ok: false, outcome: fail('missing_title', 'faltou dizer o nome') };
  if (title.length > MAX_TITLE) return { ok: false, outcome: fail('title_too_long', 'esse nome está longo demais') };
  return { ok: true, title };
}

async function createEvent(
  client: AgendaWriteClient,
  args: ManageAgendaArgs,
  ctx: ToolContext,
  agora: Date,
): Promise<Outcome> {
  const title = titleOf(args);
  if (!title.ok) return title.outcome;

  const day = resolveDay({ day: args.when_day, dayOfMonth: args.day_of_month, atTime: args.at_time }, agora);
  if (!day.ok) return fail('invalid_day', day.error);

  let body: CreateEventBody;
  if (args.at_time === undefined) {
    // `end` de dia inteiro é o último dia, inclusivo: um dia só, end = start.
    body = { title: title.title, start: day.date, end: day.date, all_day: true };
  } else {
    const start = dateTimeIso(day.date, args.at_time);
    if (!start.ok) return fail('invalid_time', start.error);
    body = { title: title.title, start: start.iso };
    if (args.duration_minutes !== undefined) {
      body.duration_minutes = Math.min(
        Math.max(Math.round(args.duration_minutes), MIN_DURATION_MINUTES),
        MAX_DURATION_MINUTES,
      );
    }
  }

  const res = await client.createEvent(body, idempotencyKey(ctx, 'event'));
  if (!res.ok) return fail(res.code, res.message);

  const created = res.data;
  const conflicts = Array.isArray(created.conflicts) ? created.conflicts : [];
  return ok(
    {
      title: cleanText(created.title) || title.title,
      spoken_when: spokenWhen(created.start, created.all_day, agora),
      ...(conflicts.length > 0
        ? { conflicts: conflicts.slice(0, MAX_CANDIDATES).map((c) => spokenConflict(c, agora)) }
        : {}),
    },
    idOf(created),
  );
}

async function createTask(
  client: AgendaWriteClient,
  args: ManageAgendaArgs,
  ctx: ToolContext,
  agora: Date,
): Promise<Outcome> {
  const title = titleOf(args);
  if (!title.ok) return title.outcome;

  // Os dois obrigatórios do Compasso. Faltando, a frase diz o que perguntar —
  // o prompt manda propor e confirmar, nunca inventar.
  if (args.effort === undefined || !(TASK_EFFORTS as readonly number[]).includes(args.effort)) {
    return fail('missing_effort', 'preciso do esforço da tarefa: 1, 2, 3, 5 ou 8', { field: 'effort' });
  }
  if (args.attribute === undefined) {
    return fail('missing_attribute', 'preciso do atributo da tarefa: corpo, mente, ofício, casa ou social', {
      field: 'attribute',
    });
  }

  const body: CreateTaskBody = { title: title.title, effort: args.effort, attribute: args.attribute };

  const hasDay = args.when_day !== undefined || args.day_of_month !== undefined;
  if (hasDay || args.at_time !== undefined) {
    // Hora sem dia é o próximo desse horário (hoje, ou amanhã se já passou):
    // "até as seis" não quer dizer "sem prazo".
    const day = resolveDay({ day: args.when_day, dayOfMonth: args.day_of_month, atTime: args.at_time }, agora);
    if (!day.ok) return fail('invalid_day', day.error);
    if (args.at_time === undefined) {
      body.due = day.date;
    } else {
      const due = dateTimeIso(day.date, args.at_time);
      if (!due.ok) return fail('invalid_time', due.error);
      body.due = due.iso;
    }
  }

  const res = await client.createTask(body, idempotencyKey(ctx, 'task'));
  if (!res.ok) return fail(res.code, res.message);

  const created = res.data;
  return ok(
    {
      title: cleanText(created.title) || title.title,
      due: created.due ? spokenDue(created.due, agora) : 'sem prazo',
    },
    idOf(created),
  );
}

async function completeTask(client: AgendaWriteClient, args: ManageAgendaArgs, agora: Date): Promise<Outcome> {
  if (args.task_id !== undefined && args.task_id.trim() !== '') {
    return finishCompletion(await client.completeTask(args.task_id.trim(), args.occurrence_date), agora);
  }

  const search = cleanText(args.title, 100);
  if (!search) return fail('missing_title', 'qual tarefa? faltou o nome');

  const pending = await client.pendingTasks({ q: search, limit: 20 });
  if (!pending.ok) return fail(pending.code, pending.message);
  let candidates: CompassoTask[] = itemsOf(pending.data).filter(isOpenTask);

  if (candidates.length === 0) {
    // Recorrente não aparece em `/tasks`; a ocorrência de hoje (ou dos
    // próximos dias) está na agenda, com o `occurrence_date` que o complete pede.
    const agenda = await client.agenda({
      from: startOfDayIso(dateAtOffset(agora, 0)),
      to: startOfDayIso(dateAtOffset(agora, RECURRING_LOOKUP_DAYS)),
      types: 'task',
      q: search,
      limit: 20,
    });
    if (!agenda.ok) return fail(agenda.code, agenda.message);

    // A mesma série aparece uma vez por ocorrência; a agenda vem ordenada por
    // início, então a primeira de cada id é a mais próxima — a única que se
    // conclui por voz. Deduplicar ANTES de olhar `done`: com a de hoje já
    // feita, pular para a de amanhã concluiria o dia errado, sem desfazer.
    const nearest = new Map<string, CompassoTask>();
    for (const item of itemsOf(agenda.data)) {
      if (item.type === 'task' && !nearest.has(item.id)) nearest.set(item.id, item);
    }
    candidates = [...nearest.values()].filter(isOpenTask);
    if (candidates.length === 0 && nearest.size > 0) {
      const done = [...nearest.values()][0]!;
      return {
        ...fail('already_done', 'essa tarefa já está marcada como feita', { title: cleanText(done.title) || 'tarefa' }),
        itemId: idOf(done),
      };
    }
  }

  if (candidates.length === 0) {
    return { ...fail('not_found', 'não encontrei tarefa pendente com esse nome'), itemCount: 0 };
  }

  if (candidates.length > 1) {
    // Concluir a errada não tem desfazer (o Compasso não suporta): pergunta.
    return {
      ...fail('ambiguous', 'achei mais de uma tarefa com esse nome — pergunte qual', {
        candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => describeItem(c, agora, true)),
      }),
      itemCount: candidates.length,
    };
  }

  const task = candidates[0]!;
  return finishCompletion(
    await client.completeTask(task.id, task.recurring ? (task.occurrence_date ?? undefined) : undefined),
    agora,
  );
}

function finishCompletion(
  res: Awaited<ReturnType<CompassoClient['completeTask']>>,
  agora: Date,
): Outcome {
  if (!res.ok) {
    return fail(res.code, res.code === 'not_found' ? 'não encontrei essa tarefa' : res.message);
  }
  const task: CompassoTask = res.data;
  return ok(
    {
      title: cleanText(task.title) || 'tarefa',
      done: task.done === true,
      ...(task.due ? { due: spokenDue(task.due, agora) } : {}),
    },
    idOf(task),
  );
}

/** Id gerado pelo Compasso, capado: é dado externo indo para o banco. */
function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id !== '' ? item.id.slice(0, 64) : null;
}

/** `items` do Compasso, ou vazio se a resposta veio fora do formato. */
function itemsOf(list: { items?: unknown }): CompassoItem[] {
  return Array.isArray(list.items) ? (list.items as CompassoItem[]) : [];
}

function isOpenTask(item: CompassoItem): item is CompassoTask {
  return item.type === 'task' && item.done !== true;
}

function spokenWhen(start: string | null, allDay: boolean, agora: Date): string {
  const parts = start ? splitIso(start) : null;
  if (!parts) return 'data não informada';
  const day = spokenDate(parts.date, agora);
  return allDay || !parts.time ? `${day}, dia inteiro` : `${day} às ${parts.time}`;
}

function spokenDue(due: string, agora: Date): string {
  const parts = splitIso(due);
  if (!parts) return 'sem prazo';
  const day = spokenDate(parts.date, agora);
  return parts.time ? `${day} até ${parts.time}` : day;
}

function spokenConflict(item: CompassoItem, agora: Date): string {
  const spoken = describeItem(item, agora, false);
  return `${spoken.title}, ${spoken.time}`;
}
