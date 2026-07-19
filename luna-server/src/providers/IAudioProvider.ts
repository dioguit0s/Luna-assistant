import type { CompletedTurn, ProviderSessionConfig, ToolCall } from './types.js';

export interface IAudioProvider {
  connect(session: ProviderSessionConfig): Promise<void>;
  sendAudio(pcm16kHz: Buffer): void;
  /**
   * Sinaliza fim de fala explicitamente (push-to-talk). Só tem efeito quando o
   * provider está com detecção automática de atividade desligada; caso
   * contrário é ignorado e o VAD do provider continua no comando.
   */
  signalActivityEnd(): void;
  onAudioResponse(callback: (chunk: Buffer) => void): void;
  onTurnComplete(callback: (turn: CompletedTurn) => void): void;
  onError(callback: (err: Error) => void): void;
  /** Notifica que a IA decidiu invocar uma das tools declaradas em `connect`. */
  onToolCall(callback: (call: ToolCall) => void): void;
  /**
   * Devolve à IA o resultado da execução de uma tool, permitindo que ela
   * verbalize a confirmação. `callId` é o mesmo recebido em `onToolCall`.
   */
  sendToolResult(callId: string, result: unknown): void;
  disconnect(): Promise<void>;
}
