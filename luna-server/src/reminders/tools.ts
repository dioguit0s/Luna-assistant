import type { ToolDefinition } from '../providers/types.js';
import type { WhenDay } from './resolveOnce.js';

/**
 * `ToolDefinition` + type guard, no mesmo molde de `CONTROL_DEVICE_TOOL`
 * (`providers/types.ts`), como manda o ADR 002. Schema **plano** — sem array,
 * sem objeto aninhado: `providers/gemini/tool-mapping.ts` só propaga `type`,
 * `description` e `enum` por propriedade, e lança em tipo desconhecido.
 *
 * `repeat` fica de fora por enquanto — este marco só cobre one-shot (relativo
 * e absoluto). Recorrência entra com `recurrence.ts`, mais adiante.
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
    },
    required: [],
  },
};

export interface SetReminderArgs {
  label?: string;
  in_seconds?: number;
  at_time?: string;
  when_day?: WhenDay;
}

/**
 * Fronteira de confiança: args são texto gerado pelo modelo. Só confere
 * *forma* (tipos, enum válido) — a semântica (exclusividade, faixa, formato de
 * `at_time`) é validada por `resolveOnceDueAt`, que devolve erro falável.
 */
export function isSetReminderArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & SetReminderArgs {
  const { label, in_seconds: inSeconds, at_time: atTime, when_day: whenDay } = args;

  if (label !== undefined && typeof label !== 'string') return false;
  if (inSeconds !== undefined && typeof inSeconds !== 'number') return false;
  if (atTime !== undefined && typeof atTime !== 'string') return false;
  if (whenDay !== undefined && !WHEN_DAY_VALUES.includes(whenDay as WhenDay)) return false;

  return true;
}

/**
 * Ações que o marco 7 embarca. `list` e `cancel` entram no marco 10
 * **alargando** este enum — alargar é retrocompatível para o modelo, e embarcar
 * agora duas ações que respondem "ainda não sei fazer isso" gastaria orçamento
 * de instrução da sessão Live (decisão 15 do plano, o vetor de TTFAB) e
 * ensinaria o modelo a chamar a tool para nada.
 */
const MANAGE_ACTIONS = ['dismiss', 'snooze'] as const;

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
    'Age sobre o alarme que está TOCANDO agora neste cômodo. Use "dismiss" ' +
    'quando pedirem para parar, desligar ou calar o alarme, e "snooze" para ' +
    'adiar ("mais cinco minutos", "soneca", "me chama de novo daqui a pouco"). ' +
    'Não serve para cancelar um lembrete que ainda não tocou. Se nada estiver ' +
    'tocando, a ferramenta avisa — não invente que desligou.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...MANAGE_ACTIONS],
        description: 'dismiss para parar o alarme, snooze para adiar.',
      },
      minutes: {
        type: 'number',
        description: 'Só para snooze: de 1 a 60 minutos. Ausente vira 5.',
      },
    },
    required: ['action'],
  },
};

export interface ManageRemindersArgs {
  action: ManageAction;
  minutes?: number;
}

/**
 * Mesma paranoia de `isSetReminderArgs`: confere só *forma*. O clamp de
 * `minutes` é do `AlarmRinger`, que devolve o valor efetivamente aplicado para
 * a Luna confirmar em voz o que foi feito, não o que foi pedido.
 */
export function isManageRemindersArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & ManageRemindersArgs {
  const { action, minutes } = args;

  if (!MANAGE_ACTIONS.includes(action as ManageAction)) return false;
  if (minutes !== undefined && typeof minutes !== 'number') return false;

  return true;
}
