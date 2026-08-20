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
  /**
   * Reconstrói o `systemPrompt` com a hora atual. `systemPrompt` já nasce
   * congelado no instante do `connect()`; providers que renovam a sessão sem
   * recriá-la do zero (ver `GeminiLiveAdapter.renewSession`) devem chamar isto
   * em vez de reusar o texto velho, senão "que horas são" fica preso na hora
   * em que a sala foi aberta pela primeira vez — potencialmente horas atrás
   * numa conversa longa.
   */
  refreshSystemPrompt: () => string;
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
 * Valida os args de `control_device` vindos do LLM. Fronteira de confiança: os
 * args são texto gerado, não payload estruturado.
 *
 * Separado do nome da tool porque quem casa o nome é o registro de dispatch do
 * Orchestrator (a chave do mapa); ao handler sobra validar o conteúdo.
 */
export function isControlDeviceArgs(
  args: Record<string, unknown>,
): args is Record<string, unknown> & ControlDeviceArgs {
  const { device, action, room_id: roomId } = args;

  return (
    typeof device === 'string' &&
    device.length > 0 &&
    typeof roomId === 'string' &&
    roomId.length > 0 &&
    (action === 'on' || action === 'off')
  );
}

/** Idem, para quem tem a `ToolCall` inteira em mãos: nome mais args. */
export function isControlDeviceCall(
  call: ToolCall,
): call is ToolCall & { args: ControlDeviceArgs } {
  return call.name === CONTROL_DEVICE_TOOL.name && isControlDeviceArgs(call.args);
}
