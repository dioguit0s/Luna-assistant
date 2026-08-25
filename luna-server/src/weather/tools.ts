import type { ToolDefinition } from '../providers/types.js';

/**
 * `ToolDefinition` + type guard, no mesmo molde de `CONTROL_DEVICE_TOOL`
 * (`providers/types.ts`) e de `SET_REMINDER_TOOL` (`reminders/tools.ts`), como
 * manda o ADR 002. Schema **plano** — sem array, sem objeto aninhado:
 * `providers/gemini/tool-mapping.ts` só propaga `type`, `description` e `enum`
 * por propriedade, e lança em tipo desconhecido.
 */

export const WEATHER_WHEN_VALUES = ['now', 'today', 'tomorrow'] as const;

export type WeatherWhen = (typeof WEATHER_WHEN_VALUES)[number];

export const GET_WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description:
    'Diz o tempo e a previsão aqui na casa: temperatura, condição do céu e ' +
    'chance de chuva. Use quando perguntarem do tempo, do calor, do frio ou ' +
    'da chuva ("está frio lá fora?", "vai chover hoje?", "e amanhã?"). ' +
    'A localização é fixa e já é conhecida pelo servidor — não existe ' +
    'parâmetro de cidade, e a ferramenta não sabe o tempo em outro lugar. ' +
    'Você não sabe que dia é hoje: mande "when" e o servidor resolve a data.',
  parameters: {
    type: 'object',
    properties: {
      when: {
        type: 'string',
        enum: [...WEATHER_WHEN_VALUES],
        description:
          'now para o tempo neste momento, today para o resto de hoje, ' +
          'tomorrow para amanhã. Ausente vira now.',
      },
    },
    required: [],
  },
};

export interface GetWeatherArgs {
  when?: WeatherWhen;
}

/**
 * Fronteira de confiança: args são texto gerado pelo modelo. `when` ausente é
 * válido de propósito — o handler trata como `'now'` — para uma pergunta
 * inofensiva sem argumento não virar "argumentos inválidos" na voz da Luna.
 */
export function isGetWeatherArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & GetWeatherArgs {
  const { when } = args;
  return when === undefined || WEATHER_WHEN_VALUES.includes(when as WeatherWhen);
}
