export type ConversationRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationRole;
  text: string;
  timestamp: number;
}

export interface CompletedTurn {
  userText?: string;
  assistantText?: string;
}

/** Subset de JSON Schema aceito pelos providers para os parâmetros de uma tool. */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * Invocação de tool emitida pela IA. `args` é intencionalmente aberto: o port
 * não conhece as tools concretas, quem consome valida com um type guard.
 */
export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ProviderSessionConfig {
  roomId: string;
  systemPrompt: string;
  history: ConversationTurn[];
  tools: ToolDefinition[];
}

export const CONTROL_DEVICE_TOOL: ToolDefinition = {
  name: 'control_device',
  description:
    'Liga ou desliga um dispositivo de automação no ambiente do usuário. ' +
    'Use quando o usuário pedir para acionar luzes ou aparelhos.',
  parameters: {
    type: 'object',
    properties: {
      device: {
        type: 'string',
        description: 'Identificador do dispositivo, ex: luz_bancada',
      },
      action: {
        type: 'string',
        enum: ['on', 'off'],
        description: 'Estado desejado do dispositivo',
      },
      room_id: {
        type: 'string',
        description: 'Área do Home Assistant onde o dispositivo está, ex: sala_de_estar',
      },
    },
    required: ['device', 'action', 'room_id'],
  },
};

export interface ControlDeviceArgs {
  device: string;
  action: 'on' | 'off';
  room_id: string;
}

/**
 * Valida uma `ToolCall` vinda do LLM contra o contrato de `control_device`.
 * Fronteira de confiança: os args são texto gerado, não payload estruturado.
 */
export function isControlDeviceCall(
  call: ToolCall,
): call is ToolCall & { args: ControlDeviceArgs } {
  if (call.name !== CONTROL_DEVICE_TOOL.name) return false;

  const { device, action, room_id: roomId } = call.args;

  return (
    typeof device === 'string' &&
    device.length > 0 &&
    typeof roomId === 'string' &&
    roomId.length > 0 &&
    (action === 'on' || action === 'off')
  );
}
