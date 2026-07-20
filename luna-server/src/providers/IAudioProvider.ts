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
  /**
   * Dispara a cada fragmento de transcrição da fala do usuário. É o melhor
   * proxy disponível de "o usuário ainda estava falando agora": quando para de
   * disparar, a fala acabou. Usado para ancorar o TTFAB no fim da fala, não no
   * último chunk de áudio recebido (que em open-mic é sempre "agora").
   */
  onUserSpeech(callback: () => void): void;
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
