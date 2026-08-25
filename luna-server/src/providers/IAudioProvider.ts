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
  /**
   * A sessão do provider encerrou sozinha (limite de duração do lado do
   * backend) e, por não haver conversa ativa, não foi renovada — manter uma
   * sessão em espera indefinidamente custaria cota/API à toa. Quem consome
   * este port deve descartar o provider cacheado: a próxima fala cria um novo
   * do zero, pelo mesmo caminho de `connect` já testado.
   */
  onSessionEnded(callback: () => void): void;
  /** Notifica que a IA decidiu invocar uma das tools declaradas em `connect`. */
  onToolCall(callback: (call: ToolCall) => void): void;
  /**
   * Devolve à IA o resultado da execução de uma tool, permitindo que ela
   * verbalize a confirmação. `callId` é o mesmo recebido em `onToolCall`.
   */
  sendToolResult(callId: string, result: unknown): void;
  /**
   * Faz a IA produzir uma fala a partir de uma instrução textual, **sem áudio
   * de entrada**. O áudio sai pelo caminho normal, por `onAudioResponse`.
   *
   * Resolve `false` quando a sessão não estava viva, ou quando o pedido não
   * pôde ser aceito agora — o caminho do alarme PRECISA saber que falhou para
   * degradar para o toque só-chime. `true` não promete que o áudio saiu:
   * promete que o pedido foi aceito pela sessão, que é o máximo que os dois
   * adapters conseguem afirmar (nenhum dos SDKs expõe liveness de verdade).
   */
  speak(instruction: string): Promise<boolean>;
  disconnect(): Promise<void>;
}
