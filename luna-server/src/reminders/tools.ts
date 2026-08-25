import type { ToolDefinition } from '../providers/types.js';
import type { WhenDay } from './resolveOnce.js';
import { REPEAT_FIELD_VALUES, type RepeatField } from './recurrence.js';

/**
 * `ToolDefinition` + type guard, no mesmo molde de `CONTROL_DEVICE_TOOL`
 * (`providers/types.ts`), como manda o ADR 002. Schema **plano** — sem array,
 * sem objeto aninhado: `providers/gemini/tool-mapping.ts` só propaga `type`,
 * `description` e `enum` por propriedade, e lança em tipo desconhecido.
 *
 * `repeat` e `when_day` são **ortogonais**, e é isso que desambigua o que um
 * CSV de dias da semana não separa: `when_day: 'fri'` com `repeat: 'none'` é
 * "sexta às 20h" (uma vez), e com `repeat: 'weekly'` é "toda sexta às 20h".
 */

const WHEN_DAY_VALUES: WhenDay[] = [
  'today',
  'tomorrow',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

export const SET_REMINDER_TOOL: ToolDefinition = {
  name: 'set_reminder',
  description:
    'Marca um alarme ou lembrete para tocar mais tarde. Use "in_seconds" para ' +
    'pedidos relativos ("daqui a 10 minutos") ou "at_time" para um horário do ' +
    'dia ("às 7", "às 19h") — nunca os dois juntos. "às sete" à noite é 19:00, ' +
    'não 07:00: resolva o período pelo contexto da conversa antes de chamar a ' +
    'tool. Sem "when_day", "at_time" cai na próxima ocorrência desse horário ' +
    '(hoje ou amanhã). Não gere data nem horário absoluto por conta própria — ' +
    'o servidor resolve.',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description:
          'O que lembrar, em poucas palavras ("tomar o remédio"). Omita para um alarme sem mensagem.',
      },
      in_seconds: {
        type: 'number',
        description: 'Daqui a quantos segundos tocar. Exclusivo com at_time.',
      },
      at_time: {
        type: 'string',
        description: '"HH:MM" 24h, horário local. Exclusivo com in_seconds.',
      },
      when_day: {
        type: 'string',
        enum: WHEN_DAY_VALUES,
        description:
          'Dia do at_time: today, tomorrow, ou o dia da semana (mon..sun). ' +
          'Omita para a próxima ocorrência desse horário.',
      },
      repeat: {
        type: 'string',
        enum: REPEAT_FIELD_VALUES,
        description:
          'Repetição: none (padrão, toca uma vez só), daily ("todo dia"), ' +
          'weekdays ("todo dia útil"), weekend ("todo fim de semana") ou ' +
          'weekly, que exige when_day com o dia da semana ("toda sexta"). ' +
          'Só use repeat quando a pessoa disser que é sempre — "sexta às 20h" ' +
          'é uma vez só; "toda sexta às 20h" é weekly.',
      },
    },
    required: [],
  },
};

export interface SetReminderArgs {
  label?: string;
  in_seconds?: number;
  at_time?: string;
  when_day?: WhenDay;
  repeat?: RepeatField;
}

/**
 * Fronteira de confiança: args são texto gerado pelo modelo. Só confere
 * *forma* (tipos, enum válido) — a semântica (exclusividade, faixa, formato de
 * `at_time`) é validada por `resolveOnceDueAt`, que devolve erro falável.
 */
export function isSetReminderArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & SetReminderArgs {
  const {
    label,
    in_seconds: inSeconds,
    at_time: atTime,
    when_day: whenDay,
    repeat,
  } = args;

  if (label !== undefined && typeof label !== 'string') return false;
  if (inSeconds !== undefined && typeof inSeconds !== 'number') return false;
  if (atTime !== undefined && typeof atTime !== 'string') return false;
  if (whenDay !== undefined && !WHEN_DAY_VALUES.includes(whenDay as WhenDay)) return false;
  if (repeat !== undefined && !REPEAT_FIELD_VALUES.includes(repeat as RepeatField)) return false;

  return true;
}

/**
 * As quatro ações de gerenciamento, numa tool só.
 *
 * Uma tool com `action: enum` em vez de quatro tools separadas: cada schema
 * entra no orçamento de instrução da sessão Live e sobe o `model_decision_ms`,
 * e com `geminiThinkingBudget: 0` o modelo não tem folga para deliberar. Mais
 * tools também sobem o falso-positivo em conversa fiada.
 */
const MANAGE_ACTIONS = ['dismiss', 'snooze', 'list', 'cancel'] as const;

export type ManageAction = (typeof MANAGE_ACTIONS)[number];

/**
 * Segunda tool do vocabulário de lembretes. Duas, e não cinco (`set`, `list`,
 * `cancel`, `snooze`, `dismiss`): cada schema entra no orçamento de instrução
 * da sessão e sobe o `model_decision_ms` — e com `geminiThinkingBudget: 0` o
 * modelo não tem folga para deliberar.
 *
 * `dismiss` e `snooze` agem sobre o alarme que está tocando **naquela sala**, e
 * por isso não pedem id: o modelo não tem como saber qual é. O system prompt
 * foi congelado no `connect`, antes de o alarme existir, então injetar uma nota
 * quando o toque começa não é opção.
 */
export const MANAGE_REMINDERS_TOOL: ToolDefinition = {
  name: 'manage_reminders',
  description:
    'Consulta e mexe nos lembretes deste cômodo. "dismiss" e "snooze" agem no ' +
    'alarme que está TOCANDO agora — para parar ("para o alarme") e para adiar ' +
    '("mais cinco minutos", "soneca"). "list" diz quais lembretes existem ' +
    '("quais alarmes eu tenho?"). "cancel" apaga um lembrete que ainda não ' +
    'tocou ("cancela o das 7", "tira o do remédio"), identificado por horário ' +
    'ou pelo texto. Se nada estiver tocando, dismiss e snooze avisam — não ' +
    'invente que desligou.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...MANAGE_ACTIONS],
        description:
          'dismiss para parar o alarme que toca agora, snooze para adiá-lo, ' +
          'list para dizer quais existem, cancel para apagar um que ainda não tocou.',
      },
      minutes: {
        type: 'number',
        description: 'Só para snooze: de 1 a 60 minutos. Ausente vira 5.',
      },
      reminder_id: {
        type: 'string',
        description: 'Só para cancel: o código curto que o list devolveu.',
      },
      at_time: {
        type: 'string',
        description:
          'Só para cancel: o horário do lembrete, "HH:MM" 24h ("cancela o das 7" → 07:00).',
      },
      label: {
        type: 'string',
        description:
          'Só para cancel: parte do texto do lembrete ("cancela o do remédio" → remédio).',
      },
    },
    required: ['action'],
  },
};

export interface ManageRemindersArgs {
  action: ManageAction;
  minutes?: number;
  reminder_id?: string;
  at_time?: string;
  label?: string;
}

/**
 * Mesma paranoia de `isSetReminderArgs`: confere só *forma*. O clamp de
 * `minutes` é do `AlarmRinger`, que devolve o valor efetivamente aplicado para
 * a Luna confirmar em voz o que foi feito, não o que foi pedido.
 */
export function isManageRemindersArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & ManageRemindersArgs {
  const { action, minutes, reminder_id: reminderId, at_time: atTime, label } = args;

  if (!MANAGE_ACTIONS.includes(action as ManageAction)) return false;
  if (minutes !== undefined && typeof minutes !== 'number') return false;
  if (reminderId !== undefined && typeof reminderId !== 'string') return false;
  if (atTime !== undefined && typeof atTime !== 'string') return false;
  if (label !== undefined && typeof label !== 'string') return false;

  return true;
}
