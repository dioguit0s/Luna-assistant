// Contrato das linhas JSON que o sidecar de wake word (wakeword-sidecar/wake_sidecar.py
// --stdin) escreve em stdout — uma linha por evento, sempre com flush imediato.
// Ver wakeword-sidecar/README.md para a tabela completa de eventos e exemplos.
//
// Módulo puro de propósito: nenhuma dependência de `child_process`, testável
// com `node --test` sem spawnar processo nenhum.

export type WakewordEvent =
  | {
      event: 'ready';
      model: string;
      model_sha256: string;
      stride: number;
      threshold: number;
      input_scale: number;
      input_zero_point: number;
    }
  | { event: 'wake'; audio_ms: number; prob: number; mean_prob: number; inference: number }
  | { event: 'eof'; audio_ms: number; inferences: number }
  | { event: 'error'; message: string };

const KNOWN_EVENTS = new Set(['ready', 'wake', 'eof', 'error']);

/**
 * Parseia uma linha de stdout do sidecar. Nunca lança — linha vazia, JSON
 * inválido, ou `event` ausente/desconhecido viram `null`. Um bug do sidecar
 * (ex. um `print()` de debug esquecido) não deve derrubar o Electron; quem
 * chama decide se loga o descarte.
 *
 * `error` pode chegar como a própria primeira linha (modelo ausente antes do
 * `ready`) — o parser é stateless por linha, então isso não exige tratamento
 * especial aqui, só do lado de quem consome o stream.
 */
export function parseWakewordLine(line: string): WakewordEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) return null;

  return parsed as WakewordEvent;
}
