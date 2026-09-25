import type {
  CompassoClient,
  CompassoItem,
  CompassoTask,
  CreateEventBody,
  CreateTaskBody,
} from '../../calendar/CompassoClient.js';
import { TASK_EFFORTS, cleanText } from '../../calendar/CompassoClient.js';
import { dateAtOffset, dateTimeIso, resolveDay, spokenDate, splitIso, startOfDayIso } from '../../calendar/dates.js';
import { describeItem } from '../../calendar/spoken.js';
import { isManageAgendaArgs, type ManageAgendaArgs } from '../../calendar/tools.js';
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
}

type Result = Record<string, unknown>;

/**
 * Handler de `manage_agenda`: criar evento, criar tarefa, concluir tarefa.
 *
 * A confirmação devolvida vem da **resposta** do Compasso, não do pedido: é o
 * que foi gravado que a Luna fala (mesma regra do `spoken_when` dos lembretes).
 */
export function createManageAgendaHandler(deps: ManageAgendaDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    if (!isManageAgendaArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'manage_agenda', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    if (!deps.client.configured) {
      return { success: false, error: 'a agenda não está configurada' };
    }

    const agora = now();
    let result: Result;
    switch (args.action) {
      case 'create_event':
        result = await createEvent(deps.client, args, ctx, agora);
        break;
      case 'create_task':
        result = await createTask(deps.client, args, ctx, agora);
        break;
      case 'complete_task':
        result = await completeTask(deps.client, args, agora);
        break;
    }

    getLogger().info(
      {
        event: 'calendar_write',
        room_id: ctx.roomId,
        action: args.action,
        success: result.success === true,
        model_decision_ms: ctx.modelDecisionMs,
      },
      `Agenda: ${args.action} ${result.success === true ? 'ok' : 'falhou'}`,
    );
    return result;
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

function titleOf(args: ManageAgendaArgs): { ok: true; title: string } | { ok: false; error: string } {
  const title = cleanText(args.title, Number.MAX_SAFE_INTEGER);
  if (!title) return { ok: false, error: 'faltou dizer o nome' };
  if (title.length > MAX_TITLE) return { ok: false, error: 'esse nome está longo demais' };
  return { ok: true, title };
}

async function createEvent(
  client: CompassoClient,
  args: ManageAgendaArgs,
  ctx: ToolContext,
  agora: Date,
): Promise<Result> {
  const title = titleOf(args);
  if (!title.ok) return { success: false, error: title.error };

  const day = resolveDay({ day: args.when_day, dayOfMonth: args.day_of_month, atTime: args.at_time }, agora);
  if (!day.ok) return { success: false, error: day.error };

  let body: CreateEventBody;
  if (args.at_time === undefined) {
    // `end` de dia inteiro é o último dia, inclusivo: um dia só, end = start.
    body = { title: title.title, start: day.date, end: day.date, all_day: true };
  } else {
    const start = dateTimeIso(day.date, args.at_time);
    if (!start.ok) return { success: false, error: start.error };
    body = { title: title.title, start: start.iso };
    if (args.duration_minutes !== undefined) {
      body.duration_minutes = Math.min(
        Math.max(Math.round(args.duration_minutes), MIN_DURATION_MINUTES),
        MAX_DURATION_MINUTES,
      );
    }
  }

  const res = await client.createEvent(body, idempotencyKey(ctx, 'event'));
  if (!res.ok) return { success: false, error: res.message };

  const created = res.data;
  const conflicts = Array.isArray(created.conflicts) ? created.conflicts : [];
  return {
    success: true,
    title: cleanText(created.title) || title.title,
    spoken_when: spokenWhen(created.start, created.all_day, agora),
    ...(conflicts.length > 0
      ? { conflicts: conflicts.slice(0, MAX_CANDIDATES).map((c) => spokenConflict(c, agora)) }
      : {}),
  };
}

async function createTask(
  client: CompassoClient,
  args: ManageAgendaArgs,
  ctx: ToolContext,
  agora: Date,
): Promise<Result> {
  const title = titleOf(args);
  if (!title.ok) return { success: false, error: title.error };

  // Os dois obrigatórios do Compasso. Faltando, a frase diz o que perguntar —
  // o prompt manda propor e confirmar, nunca inventar.
  if (args.effort === undefined || !(TASK_EFFORTS as readonly number[]).includes(args.effort)) {
    return {
      success: false,
      error: 'preciso do esforço da tarefa: 1, 2, 3, 5 ou 8',
      field: 'effort',
    };
  }
  if (args.attribute === undefined) {
    return {
      success: false,
      error: 'preciso do atributo da tarefa: corpo, mente, ofício, casa ou social',
      field: 'attribute',
    };
  }

  const body: CreateTaskBody = { title: title.title, effort: args.effort, attribute: args.attribute };

  const hasDay = args.when_day !== undefined || args.day_of_month !== undefined;
  if (hasDay || args.at_time !== undefined) {
    // Hora sem dia é o próximo desse horário (hoje, ou amanhã se já passou):
    // "até as seis" não quer dizer "sem prazo".
    const day = resolveDay({ day: args.when_day, dayOfMonth: args.day_of_month, atTime: args.at_time }, agora);
    if (!day.ok) return { success: false, error: day.error };
    if (args.at_time === undefined) {
      body.due = day.date;
    } else {
      const due = dateTimeIso(day.date, args.at_time);
      if (!due.ok) return { success: false, error: due.error };
      body.due = due.iso;
    }
  }

  const res = await client.createTask(body, idempotencyKey(ctx, 'task'));
  if (!res.ok) return { success: false, error: res.message };

  const created = res.data;
  return {
    success: true,
    title: cleanText(created.title) || title.title,
    due: created.due ? spokenDue(created.due, agora) : 'sem prazo',
  };
}

async function completeTask(client: CompassoClient, args: ManageAgendaArgs, agora: Date): Promise<Result> {
  if (args.task_id !== undefined && args.task_id.trim() !== '') {
    return finishCompletion(await client.completeTask(args.task_id.trim(), args.occurrence_date), agora);
  }

  const search = cleanText(args.title, 100);
  if (!search) return { success: false, error: 'qual tarefa? faltou o nome' };

  const pending = await client.pendingTasks({ q: search, limit: 20 });
  if (!pending.ok) return { success: false, error: pending.message };
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
    if (!agenda.ok) return { success: false, error: agenda.message };

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
      const done = [...nearest.values()][0];
      return {
        success: false,
        error: 'essa tarefa já está marcada como feita',
        title: cleanText(done.title) || 'tarefa',
      };
    }
  }

  if (candidates.length === 0) {
    return { success: false, error: 'não encontrei tarefa pendente com esse nome' };
  }

  if (candidates.length > 1) {
    // Concluir a errada não tem desfazer (o Compasso não suporta): pergunta.
    return {
      success: false,
      error: 'achei mais de uma tarefa com esse nome — pergunte qual',
      candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => describeItem(c, agora, true)),
    };
  }

  const task = candidates[0];
  return finishCompletion(
    await client.completeTask(task.id, task.recurring ? (task.occurrence_date ?? undefined) : undefined),
    agora,
  );
}

function finishCompletion(
  res: Awaited<ReturnType<CompassoClient['completeTask']>>,
  agora: Date,
): Result {
  if (!res.ok) {
    return {
      success: false,
      error: res.code === 'not_found' ? 'não encontrei essa tarefa' : res.message,
    };
  }
  const task: CompassoTask = res.data;
  return {
    success: true,
    title: cleanText(task.title) || 'tarefa',
    done: task.done === true,
    ...(task.due ? { due: spokenDue(task.due, agora) } : {}),
  };
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
