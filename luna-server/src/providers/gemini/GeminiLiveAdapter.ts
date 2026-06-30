import { GoogleGenAI, Modality } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig } from '../types.js';
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
  private userTranscript = '';
  private assistantTranscript = '';

  constructor(private readonly config: AppConfig) {}

  async connect(sessionConfig: ProviderSessionConfig): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.config.geminiApiKey });

    this.session = await ai.live.connect({
      model: this.config.geminiLiveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: sessionConfig.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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

    this.session.sendRealtimeInput({
      audio: {
        data: pcm16kHz.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
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
