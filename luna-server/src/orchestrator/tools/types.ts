import type { IAudioProvider } from '../../providers/IAudioProvider.js';

/**
 * Tudo que um handler de tool sabe sobre a invocação, explícito.
 *
 * Antes o handler de `control_device` vivia dentro do closure de
 * `bindProviderCallbacks`, com acesso direto a `startSpeaking`, `endSpeaking` e
 * ao envio para o cômodo. Um registro de handlers fora do closure perderia esse
 * acesso; dentro, seria reconstruído a cada provider. O contexto explícito
 * resolve os dois: o handler recebe o que precisa e devolve um resultado, e o
 * andaime (log de entrada, `.catch`, `sendToolResult`) fica num lugar só.
 */
export interface ToolContext {
  /**
   * Cômodo da sessão — a verdade sobre onde a coisa acontece. O `room_id` que
   * o modelo manda nos args é descartado (ADR 002): ele alucina o cômodo.
   */
  roomId: string;
  /**
   * Satélite que transmitiu por último neste cômodo, só para log. `null`
   * quando ninguém transmitiu ainda — o caso da sessão criada sem fala, pelo
   * caminho do disparo de alarme.
   */
  deviceId: string | null;
  /** Sessão viva do cômodo, para o handler que precisa responder pelo modelo. */
  provider: IAudioProvider;
  callId: string;
  /**
   * Fim da fala → decisão do modelo, em ms; `null` quando não há âncora de
   * TTFAB nesta sessão. É o termo dominante do atraso percebido, então cada
   * handler que loga despacho deve carregá-lo.
   */
  modelDecisionMs: number | null;
}

/**
 * Executa uma tool e devolve o que será entregue ao modelo via
 * `sendToolResult`. Rejeitar é permitido: o Orchestrator loga e responde ao
 * modelo com uma falha genérica — sem isso o turno do usuário ficaria
 * pendurado para sempre esperando a Luna falar.
 *
 * `args` é texto gerado pelo modelo, não payload estruturado: validar com type
 * guard é obrigação do handler (ADR 002). O registro só garante que o *nome*
 * da tool existe.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

/**
 * Resposta única para args que não passam no type guard e para tool
 * desconhecida: as duas são a mesma coisa do ponto de vista do modelo — ele
 * pediu algo que o servidor não sabe executar — e o texto é escrito para ser
 * falado, não para ser lido em log.
 */
export const INVALID_ARGS_RESULT = {
  success: false,
  error: 'argumentos inválidos',
} as const;
