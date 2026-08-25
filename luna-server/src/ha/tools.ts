import type { ToolDefinition } from '../providers/types.js';

/**
 * `ToolDefinition` + type guard, no mesmo molde de `GET_WEATHER_TOOL`
 * (`weather/tools.ts`) e `CONTROL_DEVICE_TOOL` (`providers/types.ts`), como
 * manda o ADR 002. Schema **plano** — uma propriedade só, sem array nem
 * objeto aninhado: `providers/gemini/tool-mapping.ts` lança em tipo
 * desconhecido.
 */

export const LIST_DEVICES_TOOL: ToolDefinition = {
  name: 'list_devices',
  description:
    'Lista os aparelhos de um cômodo da casa e os cômodos que você controla. ' +
    'Use quando perguntarem o que existe ou o que você controla ("quais aparelhos ' +
    'tem aqui?", "o que você controla na cozinha?", "que ambientes você controla?"). ' +
    'Devolve só nomes: não diz se está ligado ou desligado, e não aciona nada.',
  parameters: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description:
          'Cômodo a listar, como a pessoa falou ("cozinha"). Omita quando não ' +
          'disserem o cômodo: o servidor usa o de onde você está ouvindo.',
      },
    },
    required: [],
  },
};

export interface ListDevicesArgs {
  room_id?: string;
}

/**
 * Fronteira de confiança: args são texto gerado pelo modelo. `room_id`
 * ausente é válido de propósito — o handler cai no cômodo da sessão — para
 * uma pergunta sem argumento não virar "argumentos inválidos" na voz da Luna.
 */
export function isListDevicesArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & ListDevicesArgs {
  const { room_id: roomId } = args;
  return roomId === undefined || typeof roomId === 'string';
}
