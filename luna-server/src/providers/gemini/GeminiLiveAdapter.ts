import { GoogleGenAI, Modality, EndSensitivity } from '@google/genai';
import type { AutomaticActivityDetection } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../types.js';
import { resample24kTo16k } from '../utils/resampler.js';
import { getLogger } from '../../logging/logger.js';
import {
  normalizeToolCalls,
  toGeminiFunctionDeclarations,
  type RawToolCall,
} from './tool-mapping.js';

type LiveSession = Awaited<
  ReturnType<InstanceType<typeof GoogleGenAI>['live']['connect']>
>;

export class GeminiLiveAdapter implements IAudioProvider {
  private session: LiveSession | null = null;
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private toolCallCb: ((call: ToolCall) => void) | null = null;
  private userSpeechCb: (() => void) | null = null;
  private userTranscript = '';
  private assistantTranscript = '';
  private activityOpen = false;
  private roomId = '';
  /** callId → nome da função. O SDK exige o `name` de volta no `functionResponse`. */
  private readonly pendingToolCalls = new Map<string, string>();

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
    this.roomId = sessionConfig.roomId;

    this.session = await ai.live.connect({
      model: this.config.geminiLiveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: sessionConfig.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(sessionConfig.tools.length > 0
          ? {
              tools: [
                { functionDeclarations: toGeminiFunctionDeclarations(sessionConfig.tools) },
              ],
            }
          : {}),
        ...(automaticActivityDetection
          ? { realtimeInputConfig: { automaticActivityDetection } }
          : {}),
        // Sem limite explícito, o native-audio pensa antes de responder — e o
        // raciocínio inteiro acontece antes da tool call, dentro do atraso
        // percebido. `null` omite o campo (modelos sem thinking rejeitam a
        // sessão se ele estiver presente).
        ...(this.config.geminiThinkingBudget !== null
          ? { thinkingConfig: { thinkingBudget: this.config.geminiThinkingBudget } }
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

  onUserSpeech(callback: () => void): void {
    this.userSpeechCb = callback;
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

  sendToolResult(callId: string, result: unknown): void {
    const name = this.pendingToolCalls.get(callId);

    // Sem o `name` o SDK rejeita o functionResponse. Um callId desconhecido é
    // bug de correlação, mas lançar aqui derrubaria o turno inteiro do usuário.
    if (!this.session || !name) {
      getLogger().warn(
        { room_id: this.roomId, call_id: callId },
        'sendToolResult para callId desconhecido ou sessão fechada',
      );
      return;
    }

    this.pendingToolCalls.delete(callId);

    // A API exige um objeto JSON; primitivos vão sob a chave "output".
    const response =
      typeof result === 'object' && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { output: result };

    this.session.sendToolResponse({
      functionResponses: [{ id: callId, name, response }],
    });
  }

  async disconnect(): Promise<void> {
    this.pendingToolCalls.clear();
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }

  private handleMessage(message: {
    toolCall?: RawToolCall;
    goAway?: { timeLeft?: string };
    serverContent?: {
      inputTranscription?: { text?: string };
      outputTranscription?: { text?: string };
      modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
      turnComplete?: boolean;
      interrupted?: boolean;
      generationComplete?: boolean;
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

    // Investigação da fala duplicada num único turno (ver commit da retry de
    // HA): se `interrupted`/`goAway`/`generationComplete` aparecerem perto de
    // um `outputTranscription` repetido, é o servidor do Gemini reiniciando a
    // geração, não um bug nosso de reenvio. Fica ligado sempre (barato,
    // dispara raro) até confirmarmos a causa.
    if (message.goAway) {
      getLogger().warn(
        { event: 'gemini_go_away', room_id: this.roomId, time_left: message.goAway.timeLeft },
        `Gemini avisou goAway (tempo restante: ${message.goAway.timeLeft ?? 'desconhecido'})`,
      );
    }
    if (message.serverContent?.interrupted) {
      getLogger().warn(
        { event: 'gemini_interrupted', room_id: this.roomId },
        'Gemini reportou serverContent.interrupted',
      );
    }
    if (message.serverContent?.outputTranscription?.text) {
      getLogger().info(
        {
          event: 'assistant_transcript_delta',
          room_id: this.roomId,
          text: message.serverContent.outputTranscription.text,
          generation_complete: message.serverContent.generationComplete ?? null,
        },
        `Delta de transcrição da Luna: "${message.serverContent.outputTranscription.text}"`,
      );
    }

    // `toolCall` chega na raiz da mensagem, fora de `serverContent` — precisa
    // ser tratado antes do early return abaixo.
    if (message.toolCall) {
      for (const call of normalizeToolCalls(message.toolCall)) {
        this.pendingToolCalls.set(call.callId, call.name);
        getLogger().info(
          { event: 'tool_call', room_id: this.roomId, name: call.name, call_id: call.callId },
          `Tool call recebida: ${call.name}`,
        );
        this.toolCallCb?.(call);
      }
    }

    const serverContent = message.serverContent;

    if (!serverContent) return;

    if (serverContent.inputTranscription?.text) {
      this.userTranscript += serverContent.inputTranscription.text;
      this.userSpeechCb?.();
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
