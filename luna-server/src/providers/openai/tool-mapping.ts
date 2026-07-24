import type { ToolCall, ToolDefinition, ToolParameterSchema } from '../types.js';

/** Tool no dialeto da Realtime: `type: 'function'` com os campos na raiz. */
export interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/** Item `function_call` cru de `response.output_item.done` / `response.done`. */
export interface RawFunctionCallItem {
  type?: string;
  call_id?: string;
  name?: string;
  /** Argumentos chegam serializados, não como objeto. */
  arguments?: string;
}

/**
 * Diferente do Gemini, que exige o enum `Type` do SDK e obriga a traduzir cada
 * tipo, a Realtime aceita JSON Schema direto — `tool.parameters` passa inteiro.
 * Por isso não existe aqui o equivalente a `toSchemaType`.
 */
export function toOpenAIFunctionTools(tools: ToolDefinition[]): OpenAIFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Normaliza um item `function_call` para o contrato do port. Devolve `null` —
 * nunca lança — em item malformado: `arguments` é texto gerado por modelo, e uma
 * exceção aqui derrubaria o `handleMessage` inteiro, matando a sessão por causa
 * de um turno ruim. Sem `call_id` não há como responder; sem `name` não há o que
 * despachar. Mesma política do `normalizeToolCalls` do Gemini.
 */
export function normalizeFunctionCallItem(item: RawFunctionCallItem): ToolCall | null {
  if (!item.call_id || !item.name) return null;

  let args: Record<string, unknown> = {};

  if (item.arguments) {
    try {
      const parsed: unknown = JSON.parse(item.arguments);
      // Um array ou primitivo vira `{}` de propósito: o type guard da tool
      // reprova e o Orchestrator responde "argumentos inválidos" pela IA, em vez
      // de a sessão morrer ou o comando seguir com args de forma inesperada.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return { callId: item.call_id, name: item.name, args };
}
