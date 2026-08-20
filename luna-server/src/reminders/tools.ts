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
