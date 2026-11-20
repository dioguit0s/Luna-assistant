import { getLogger } from '../logging/logger.js';

/**
 * Histórico do que a Luna consultou ou criou no Compasso (painel › Agenda).
 *
 * **Privacidade, mesmo princípio do `logTap`:** só enum, número e o id que o
 * Compasso gerou. Nada de `search`, `title` ou outro texto livre dos args — é
 * o que a pessoa falou, e o histórico não é transcrição. Guardar o título de
 * um item criado seria útil, mas é decisão explícita (issue/ADR), não detalhe
 * de implementação.
 */

export type AgendaTool = 'get_agenda' | 'manage_agenda';
export type AgendaLogAction = 'query' | 'create_event' | 'create_task' | 'complete_task';

export interface AgendaLogEntry {
  at: number;
  roomId: string;
  tool: AgendaTool;
  /** `null` só quando o `manage_agenda` chegou sem `action` válida. */
  action: AgendaLogAction | null;
  /** `when` do `get_agenda` ou `when_day` do `manage_agenda` — sempre um valor do enum. */
  when: string | null;
  dayOfMonth: number | null;
  kind: string | null;
  effort: number | null;
  attribute: string | null;
  /** Só a presença: o texto da busca nunca é gravado. */
  hasSearch: boolean;
  /**
   * `ok`, o `error.code` do Compasso (`unauthorized`, `unreachable`...) ou um
   * motivo fixo deste lado (`invalid_args`, `missing_effort`, `ambiguous`...).
   */
  result: string;
  /** Itens que o Compasso devolveu (consulta) ou candidatos achados (conclusão ambígua). */
  itemCount: number | null;
  /** Id do item criado ou concluído, como o Compasso devolveu. */
  itemId: string | null;
  /** Soma das idas ao Compasso; `null` se nem chamou (args inválidos, não configurado). */
  latencyMs: number | null;
}

/** O que os handlers recebem. Nunca lança e nunca atrasa a resposta da tool. */
export interface AgendaEventSink {
  record(entry: AgendaLogEntry): void;
}

/**
 * Grava no próximo giro do event loop, fora do caminho da resposta: o resultado
 * da tool vai ao modelo antes do `INSERT`. Falha de escrita vira `warn` e some
 * — o histórico é diagnóstico, a agenda em si não depende dele.
 */
export function deferredAgendaSink(insert: (entry: AgendaLogEntry) => void): AgendaEventSink {
  return {
    record(entry) {
      setImmediate(() => {
        try {
          insert(entry);
        } catch (err) {
          getLogger().warn(
            { event: 'agenda_log_failed', room_id: entry.roomId, err: err instanceof Error ? err.message : String(err) },
            'Não consegui gravar o histórico da agenda',
          );
        }
      });
    },
  };
}

/** Número que veio do modelo, só se for inteiro razoável; o resto não vale guardar. */
export function loggableInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
