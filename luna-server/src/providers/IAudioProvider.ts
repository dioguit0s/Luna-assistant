import type { CompletedTurn, ProviderSessionConfig } from './types.js';

export interface IAudioProvider {
  connect(session: ProviderSessionConfig): Promise<void>;
  sendAudio(pcm16kHz: Buffer): void;
  onAudioResponse(callback: (chunk: Buffer) => void): void;
  onTurnComplete(callback: (turn: CompletedTurn) => void): void;
  onError(callback: (err: Error) => void): void;
  disconnect(): Promise<void>;
}
