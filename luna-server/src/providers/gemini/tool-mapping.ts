import { Type } from '@google/genai';
import type { FunctionDeclaration, Schema } from '@google/genai';
import type { ToolDefinition, ToolCall } from '../types.js';

/** Formato cru de `message.toolCall` do Live API (campos todos opcionais no SDK). */
export interface RawToolCall {
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
}

/** Propriedade do JSON Schema aceito em `ToolParameterSchema.properties`. */
interface JsonSchemaProperty {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
}

/**
 * O port declara tools em JSON Schema (`type: 'string'`), o SDK espera o enum
 * `Type` (`Type.STRING`). Tipo desconhecido lança em vez de virar schema
 * silenciosamente inválido — a sessão subiria sem a tool e o sintoma apareceria
 * só na hora em que a IA deixasse de acionar o dispositivo.
 */
function toSchemaType(type: unknown, context: string): Type {
  switch (type) {
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'integer':
      return Type.INTEGER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'object':
      return Type.OBJECT;
    case 'array':
      return Type.ARRAY;
    default:
      throw new Error(
        `Tipo de JSON Schema não suportado em ${context}: ${JSON.stringify(type)}`,
      );
  }
}

function toPropertySchema(name: string, raw: unknown): Schema {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Propriedade ${name} não é um objeto de schema`);
  }

  const { type, description, enum: enumValues } = raw as JsonSchemaProperty;

  return {
    type: toSchemaType(type, `propriedade ${name}`),
    ...(typeof description === 'string' ? { description } : {}),
    ...(Array.isArray(enumValues) ? { enum: enumValues as string[] } : {}),
  };
}

export function toGeminiFunctionDeclarations(
  tools: ToolDefinition[],
): FunctionDeclaration[] {
  return tools.map((tool) => {
    const properties: Record<string, Schema> = {};
    for (const [name, raw] of Object.entries(tool.parameters.properties)) {
      properties[name] = toPropertySchema(`${tool.name}.${name}`, raw);
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: toSchemaType(tool.parameters.type, `tool ${tool.name}`),
        properties,
        ...(tool.parameters.required ? { required: tool.parameters.required } : {}),
      },
    };
  });
}

/**
 * Normaliza `message.toolCall` para o contrato do port. Invocações sem `id` ou
 * sem `name` são descartadas: sem `id` não há como responder por `callId`, e
 * sem `name` não há o que despachar.
 */
export function normalizeToolCalls(toolCall: RawToolCall): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const call of toolCall.functionCalls ?? []) {
    if (!call.id || !call.name) continue;
    calls.push({ callId: call.id, name: call.name, args: call.args ?? {} });
  }

  return calls;
}
