import { GoogleGenAI, Modality, EndSensitivity } from '@google/genai';
import type { AutomaticActivityDetection } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../types.js';
import { resample24kTo16k } from '../utils/resampler.js';
import { getLogger } from '../../logging/logger.js';

type LiveSession = Awaited<
  ReturnType<InstanceType<typeof GoogleGenAI>['live']['connect']>
>;

export class GeminiLiveAdapter implements IAudioProvider {
  private session: LiveSession | null = null;
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private toolCallCb: ((call: ToolCall) => void) | null = null;
  private userTranscript = '';
  private assistantTranscript = '';
  private activityOpen = false;

  constructor(private readonly config: AppConfig) {}

  /**
   * Janela de silêncio do VAD entra direto no caminho crítico do TTFAB: o Gemini
   * só começa a gerar depois de confirmar o fim da fala. Sem override, o default
   * do SDK é END_SENSITIVITY_LOW (fecha o turno mais tarde).
   */
  private buildActivityDetection(): AutomaticActivityDetection | undefined {
    const { geminiVadSilenceMs, geminiVadEndSensitivity, geminiManualActivity } = this.config;

    // Push-to-talk: o satélite sabe o instante exato em que o botão foi solto,
    // então não faz sentido pagar o endpointing por áudio do servidor.
    if (geminiManualActivity) {
      return { disabled: true };
    }

    if (geminiVadSilenceMs === null && geminiVadEndSensitivity === null) {
      return undefined;
    }

    return {
      ...(geminiVadSilenceMs !== null ? { silenceDurationMs: geminiVadSilenceMs } : {}),
      ...(geminiVadEndSensitivity !== null
        ? {
            endOfSpeechSensitivity:
              geminiVadEndSensitivity === 'HIGH'
                ? EndSensitivity.END_SENSITIVITY_HIGH
                : EndSensitivity.END_SENSITIVITY_LOW,
          }
        : {}),
    };
  }

  async connect(sessionConfig: ProviderSessionConfig): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
    const automaticActivityDetection = this.buildActivityDetection();

    this.session = await ai.live.connect({
      model: this.config.geminiLiveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: sessionConfig.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // TODO(LUNA-306): mapear `sessionConfig.tools` para
        // `tools: [{ functionDeclarations: [...] }]` e tratar `message.toolCall`.
        ...(automaticActivityDetection
          ? { realtimeInputConfig: { automaticActivityDetection } }
          : {}),
      },
      callbacks: {
        onmessage: (message) => this.handleMessage(message),
        onerror: (e: { message?: string }) => {
          this.errorCb?.(new Error(e.message ?? 'Erro Gemini Live'));
        },
      },
    });

    getLogger().info(
      { room_id: sessionConfig.roomId, provider: 'gemini' },
      'Sessão Gemini Live conectada',
    );
  }

  sendAudio(pcm16kHz: Buffer): void {
    if (!this.session) {
      throw new Error('GeminiLiveAdapter não conectado');
    }

    // Sem VAD do servidor, o turno só abre se marcarmos o início explicitamente.
    if (this.config.geminiManualActivity && !this.activityOpen) {
      this.session.sendRealtimeInput({ activityStart: {} });
      this.activityOpen = true;
    }

    this.session.sendRealtimeInput({
      audio: {
        data: pcm16kHz.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
  }

  signalActivityEnd(): void {
    if (!this.session || !this.config.geminiManualActivity || !this.activityOpen) {
      return;
    }
    this.session.sendRealtimeInput({ activityEnd: {} });
    this.activityOpen = false;
  }

  onAudioResponse(callback: (chunk: Buffer) => void): void {
    this.audioResponseCb = callback;
  }

  onTurnComplete(callback: (turn: CompletedTurn) => void): void {
    this.turnCompleteCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  onToolCall(callback: (call: ToolCall) => void): void {
    this.toolCallCb = callback;
  }

  sendToolResult(_callId: string, _result: unknown): void {
    throw new Error('GeminiLiveAdapter.sendToolResult não implementado (LUNA-306)');
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }

  private handleMessage(message: {
    serverContent?: {
      inputTranscription?: { text?: string };
      outputTranscription?: { text?: string };
      modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
      turnComplete?: boolean;
    };
  }): void {
    // Diagnóstico de sessão (foi assim que apareceu o `interrupted` do modo
    // manual). Expõe transcrição da fala do usuário no log — só em depuração.
    if (this.config.geminiDebugMessages) {
      getLogger().info(
        { raw: JSON.stringify(message).slice(0, 300) },
        'DEBUG mensagem Gemini',
      );
    }

    const serverContent = message.serverContent;

    if (!serverContent) return;

    if (serverContent.inputTranscription?.text) {
      this.userTranscript += serverContent.inputTranscription.text;
    }

    if (serverContent.outputTranscription?.text) {
      this.assistantTranscript += serverContent.outputTranscription.text;
    }

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data && this.audioResponseCb) {
        const pcm24k = Buffer.from(data, 'base64');
        const pcm16k = resample24kTo16k(pcm24k);
        this.audioResponseCb(pcm16k);
      }
    }

    if (serverContent.turnComplete) {
      this.turnCompleteCb?.({
        userText: this.userTranscript.trim() || undefined,
        assistantText: this.assistantTranscript.trim() || undefined,
      });
      this.userTranscript = '';
      this.assistantTranscript = '';
    }
  }
}
