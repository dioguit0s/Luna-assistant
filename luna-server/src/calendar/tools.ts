import type { ToolDefinition } from '../providers/types.js';
import { TASK_ATTRIBUTES, type TaskAttribute } from './CompassoClient.js';
import { DAY_VALUES, RANGE_VALUES, type DayValue, type QueryWhen } from './dates.js';

/**
 * `ToolDefinition` + type guard, no molde do ADR 002. Schema **plano** — sem
 * array, sem objeto aninhado: `providers/gemini/tool-mapping.ts` só propaga
 * `type`, `description` e `enum` por propriedade.
 *
 * Duas tools, não sete (consultar dia, semana, buscar, pendentes, criar evento,
 * criar tarefa, concluir): cada schema entra no orçamento de instrução da
 * sessão Live e sobe o `model_decision_ms`. Leitura e escrita ficam separadas
 * porque a escrita tem regra própria — pedir esforço e atributo antes de criar
 * tarefa — e misturar as duas numa tool só convidaria o modelo a "consultar"
 * pelo caminho que cria.
 *
 * Nenhuma aceita data absoluta: dia da semana, "hoje/amanhã" ou dia do mês, e
 * o servidor resolve (ADR 006, decisão 6).
 */

const QUERY_WHEN_VALUES: QueryWhen[] = [...DAY_VALUES, ...RANGE_VALUES];

export const AGENDA_KINDS = ['all', 'events', 'classes', 'tasks', 'pending_tasks'] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];

export const GET_AGENDA_TOOL: ToolDefinition = {
  name: 'get_agenda',
  description:
    'Consulta a agenda do usuário no Compasso: compromissos, aulas da faculdade ' +
    'e tarefas com prazo. Use para "o que eu tenho hoje?", "tenho aula amanhã?", ' +
    '"como está minha semana?", "quando é a prova de cálculo?", "quais tarefas ' +
    'estão pendentes?". Não é para os alarmes e lembretes da Luna — esses são ' +
    'manage_reminders. Você não sabe que dia é hoje: mande when ou day_of_month ' +
    'e o servidor resolve a data.',
  parameters: {
    type: 'object',
    properties: {
      when: {
        type: 'string',
        enum: QUERY_WHEN_VALUES,
        description:
          'today, tomorrow, um dia da semana (mon..sun, o próximo — hoje conta), ' +
          'week para os próximos 7 dias, next_week para a semana que vem, ' +
          'upcoming para procurar nos próximos meses. Ausente vira today, ou ' +
          'upcoming quando há search. Exclusivo com day_of_month.',
      },
      day_of_month: {
        type: 'number',
        description: 'Dia do mês, 1 a 31, para "dia 30": o próximo com esse número. Exclusivo com when.',
      },
      kind: {
        type: 'string',
        enum: [...AGENDA_KINDS],
        description:
          'all (padrão) para tudo, events para compromissos, classes para aulas, ' +
          'tasks para tarefas com prazo no período, pending_tasks para todas as ' +
          'tarefas não feitas, com e sem prazo (ignora when).',
      },
      search: {
        type: 'string',
        description:
          'Palavras do título, para achar um item específico ("prova cálculo"). ' +
          'Sem search, lista o período inteiro.',
      },
    },
    required: [],
  },
};

export interface GetAgendaArgs {
  when?: QueryWhen;
  day_of_month?: number;
  kind?: AgendaKind;
  search?: string;
}

/** Só forma; a semântica (exclusividade, faixa do dia) é de `resolveRange`. */
export function isGetAgendaArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & GetAgendaArgs {
  const { when, day_of_month: dayOfMonth, kind, search } = args;
  if (when !== undefined && !QUERY_WHEN_VALUES.includes(when as QueryWhen)) return false;
  if (dayOfMonth !== undefined && typeof dayOfMonth !== 'number') return false;
  if (kind !== undefined && !AGENDA_KINDS.includes(kind as AgendaKind)) return false;
  if (search !== undefined && typeof search !== 'string') return false;
  return true;
}

export const AGENDA_ACTIONS = ['create_event', 'create_task', 'complete_task'] as const;
export type AgendaAction = (typeof AGENDA_ACTIONS)[number];

export const MANAGE_AGENDA_TOOL: ToolDefinition = {
  name: 'manage_agenda',
  description:
    'Escreve na agenda do usuário no Compasso. create_event marca um compromisso ' +
    '("marca reunião do grupo sexta às 14h"). create_task cria uma tarefa ' +
    '("coloca na agenda pagar a conta de luz") e EXIGE effort e attribute: se o ' +
    'usuário não disse, proponha os dois e espere o sim antes de chamar — nunca ' +
    'invente em silêncio. complete_task marca uma tarefa como feita. Não edita, ' +
    'não move, não apaga e não cria nada recorrente. Alarme ou lembrete que a ' +
    'Luna toca é set_reminder, não isto.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...AGENDA_ACTIONS],
        description: 'create_event, create_task ou complete_task.',
      },
      title: {
        type: 'string',
        description:
          'Título curto do evento ou da tarefa. Em complete_task sem task_id, ' +
          'palavras do título da tarefa a concluir.',
      },
      when_day: {
        type: 'string',
        enum: [...DAY_VALUES],
        description:
          'Dia do evento ou prazo da tarefa: today, tomorrow ou o próximo dia da ' +
          'semana (mon..sun). Exclusivo com day_of_month. Evento sem dia é hoje; ' +
          'tarefa sem dia fica sem prazo.',
      },
      day_of_month: {
        type: 'number',
        description: 'Dia do mês, 1 a 31, para "dia 30". Exclusivo com when_day.',
      },
      at_time: {
        type: 'string',
        description:
          '"HH:MM" 24h, horário local. Evento sem at_time é de dia inteiro. Em ' +
          'tarefa, prazo com hora. "às três" à tarde é 15:00: resolva o período ' +
          'pela conversa antes de chamar.',
      },
      duration_minutes: {
        type: 'number',
        description: 'Só create_event com at_time: duração em minutos. Ausente vira 60.',
      },
      effort: {
        type: 'number',
        description: 'Só create_task: 1, 2, 3, 5 ou 8 — de trivial a muito grande.',
      },
      attribute: {
        type: 'string',
        enum: [...TASK_ATTRIBUTES],
        description: 'Só create_task: corpo, mente, oficio, casa ou social.',
      },
      task_id: {
        type: 'string',
        description: 'Só complete_task: o task_id que get_agenda devolveu.',
      },
      occurrence_date: {
        type: 'string',
        description:
          'Só complete_task de tarefa recorrente: o occurrence_date que ' +
          'get_agenda devolveu junto do task_id, sem alterar.',
      },
    },
    required: ['action'],
  },
};

export interface ManageAgendaArgs {
  action: AgendaAction;
  title?: string;
  when_day?: DayValue;
  day_of_month?: number;
  at_time?: string;
  duration_minutes?: number;
  effort?: number;
  attribute?: TaskAttribute;
  task_id?: string;
  occurrence_date?: string;
}

/**
 * Só forma. `effort` fora de {1,2,3,5,8} passa aqui e é recusado no handler
 * com frase falável — "argumentos inválidos" não diria ao modelo o que corrigir.
 */
export function isManageAgendaArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & ManageAgendaArgs {
  const {
    action,
    title,
    when_day: whenDay,
    day_of_month: dayOfMonth,
    at_time: atTime,
    duration_minutes: duration,
    effort,
    attribute,
    task_id: taskId,
    occurrence_date: occurrenceDate,
  } = args;

  if (!AGENDA_ACTIONS.includes(action as AgendaAction)) return false;
  if (title !== undefined && typeof title !== 'string') return false;
  if (whenDay !== undefined && !DAY_VALUES.includes(whenDay as DayValue)) return false;
  if (dayOfMonth !== undefined && typeof dayOfMonth !== 'number') return false;
  if (atTime !== undefined && typeof atTime !== 'string') return false;
  if (duration !== undefined && typeof duration !== 'number') return false;
  if (effort !== undefined && typeof effort !== 'number') return false;
  if (attribute !== undefined && !TASK_ATTRIBUTES.includes(attribute as TaskAttribute)) return false;
  if (taskId !== undefined && typeof taskId !== 'string') return false;
  if (occurrenceDate !== undefined && typeof occurrenceDate !== 'string') return false;
  return true;
}
