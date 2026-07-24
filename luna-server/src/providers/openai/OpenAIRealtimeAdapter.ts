import WebSocket from 'ws';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../types.js';
import { resample16kTo24k, resample24kTo16k } from '../utils/resampler.js';
import { getLogger } from '../../logging/logger.js';
import {
  normalizeFunctionCallItem,
  toOpenAIFunctionTools,
  type RawFunctionCallItem,
} from './tool-mapping.js';

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  item?: RawFunctionCallItem;
  response?: { output?: RawFunctionCallItem[] };
}

interface TurnDetectionConfig {
  type: string;
  silence_duration_ms?: number;
}

export class OpenAIRealtimeAdapter implements IAudioProvider {
  private ws: WebSocket | null = null;
  private connected = false;
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private toolCallCb: ((call: ToolCall) => void) | null = null;
  private userSpeechCb: (() => void) | null = null;
  private userTranscript = '';
  private assistantTranscript = '';
  private roomId = '';
  /**
   * Calls da resposta em voo ainda sem resultado. Só quando esvazia é que sai o
   * `response.create` — ver `sendToolResult`.
   */
  private readonly pendingToolCalls = new Set<string>();

  constructor(private readonly config: AppConfig) {}

  /**
   * `server_vad` corta por silêncio (a janela entra direto no TTFAB, como no
   * Gemini); `semantic_vad` decide pelo conteúdo da fala e ignora duração de
   * silêncio — mandar `silence_duration_ms` junto seria config morta.
   */
  private buildTurnDetection(): TurnDetectionConfig {
    const { openaiVadType, openaiVadSilenceMs } = this.config;

    if (openaiVadType === 'semantic_vad') {
      return { type: 'semantic_vad' };
    }

    return {
      type: 'server_vad',
      ...(openaiVadSilenceMs !== null ? { silence_duration_ms: openaiVadSilenceMs } : {}),
    };
  }

  async connect(sessionConfig: ProviderSessionConfig): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openaiRealtimeModel)}`;
    this.roomId = sessionConfig.roomId;

    await new Promise<void>((resolve, reject) => {
      // Sem `OpenAI-Beta`: o header pertencia ao dialeto beta, que tinha a
      // configuração de áudio achatada na raiz da sessão.
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.sendEvent({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: sessionConfig.systemPrompt,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                turn_detection: this.buildTurnDetection(),
                transcription: { model: 'gpt-4o-mini-transcribe' },
              },
              output: {
                format: { type: 'audio/pcm' },
                voice: this.config.openaiVoice,
              },
            },
            // Mesmo guard do Gemini: sessão sem tools não declara o campo.
            ...(sessionConfig.tools.length > 0
              ? {
                  tools: toOpenAIFunctionTools(sessionConfig.tools),
                  tool_choice: 'auto',
                }
              : {}),
          },
        });
        getLogger().info(
          { room_id: sessionConfig.roomId, provider: 'openai' },
          'Sessão OpenAI Realtime conectada',
        );
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        this.errorCb?.(err);
        if (!this.connected) reject(err);
      });

      this.ws.on('close', () => {
        this.connected = false;
      });
    });
  }

  sendAudio(pcm16kHz: Buffer): void {
    if (!this.ws || !this.connected) {
      throw new Error('OpenAIRealtimeAdapter não conectado');
    }

    const pcm24k = resample16kTo24k(pcm16kHz);
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: pcm24k.toString('base64'),
    });
  }

  signalActivityEnd(): void {
    // A sessão é criada com turn detection do lado do servidor; sem desligá-la
    // no session.update, um commit manual conflita com o VAD da OpenAI.
    // Implementado como no-op até que o caminho manual seja habilitado aqui.
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
    // callId desconhecido é bug de correlação, mas lançar aqui derrubaria o
    // turno inteiro do usuário — mesma política do Gemini.
    if (!this.ws || !this.connected || !this.pendingToolCalls.has(callId)) {
      getLogger().warn(
        { room_id: this.roomId, call_id: callId },
        'sendToolResult para callId desconhecido ou sessão fechada',
      );
      return;
    }

    this.pendingToolCalls.delete(callId);

    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        // A API exige string; o Gemini aceita o objeto. Serializar é obrigatório.
        output: JSON.stringify(result),
      },
    });

    // Um `response.create` por resposta, não por call: com duas tools acionadas
    // no mesmo turno, disparar por call geraria duas respostas faladas
    // sobrepostas. O Orchestrator responde todo callId em todos os caminhos
    // (args inválidos, device não resolvido, retorno do HA), então o set sempre
    // esvazia.
    if (this.pendingToolCalls.size === 0) {
      this.sendEvent({ type: 'response.create' });
    }
  }

  async disconnect(): Promise<void> {
    this.pendingToolCalls.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(event));
  }

  private handleMessage(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }

    if (this.config.openaiDebugMessages) {
      getLogger().info({ raw: raw.slice(0, 300) }, 'DEBUG mensagem OpenAI');
    }

    switch (event.type) {
      case 'response.output_audio.delta':
        if (event.delta) {
          const pcm24k = Buffer.from(event.delta, 'base64');
          const pcm16k = resample24kTo16k(pcm24k);
          this.audioResponseCb?.(pcm16k);
        }
        break;

      // O VAD da OpenAI publica o fim de fala explicitamente — âncora exata do
      // TTFAB, melhor que o proxy por transcrição usado no Gemini.
      case 'input_audio_buffer.speech_stopped':
        this.userSpeechCb?.();
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.userTranscript = event.transcript;
        }
        break;

      case 'response.output_audio_transcript.done':
        if (event.transcript) {
          this.assistantTranscript = event.transcript;
        }
        break;

      // Evento auto-contido mais cedo do fluxo de tool call: traz call_id, name
      // e arguments juntos. `response.done` chegaria tarde demais (o atraso
      // entraria inteiro no model_decision_ms, que é justamente o que medimos) e
      // `response.function_call_arguments.done` não carrega o name.
      case 'response.output_item.done':
        this.handleOutputItem(event.item);
        break;

      case 'response.done':
        this.handleResponseDone(event.response?.output ?? []);
        break;

      case 'error':
        this.errorCb?.(new Error(event.error?.message ?? 'Erro OpenAI Realtime'));
        break;
    }
  }

  private handleOutputItem(item: RawFunctionCallItem | undefined): void {
    if (item?.type !== 'function_call') return;

    const call = normalizeFunctionCallItem(item);

    if (!call) {
      getLogger().warn(
        { room_id: this.roomId, call_id: item.call_id ?? null },
        'Item function_call malformado descartado',
      );
      return;
    }

    this.pendingToolCalls.add(call.callId);
    getLogger().info(
      { event: 'tool_call', room_id: this.roomId, name: call.name, call_id: call.callId },
      `Tool call recebida: ${call.name}`,
    );
    this.toolCallCb?.(call);
  }

  /**
   * No Gemini, tool call e confirmação falada vivem no mesmo turno. Aqui são
   * duas respostas: a primeira só com o `function_call`, a segunda — disparada
   * pelo nosso `response.create` — com o áudio. Emitir `turnComplete` na
   * primeira cancelaria o debounce de `speaking_start` (LED aceso e mic aberto
   * durante todo o round-trip do HA), zeraria a âncora do TTFAB antes do áudio
   * chegar e sujaria a série `turn_complete` com um turno sem fala.
   *
   * Por isso a transcrição do usuário também não é limpa nesse caso: ela precisa
   * sobreviver até o `response.done` da segunda resposta para o ring buffer
   * parear a fala com a confirmação.
   */
  private handleResponseDone(output: RawFunctionCallItem[]): void {
    const onlyFunctionCalls =
      output.length > 0 && output.every((item) => item.type === 'function_call');

    if (onlyFunctionCalls) return;

    this.turnCompleteCb?.({
      userText: this.userTranscript.trim() || undefined,
      assistantText: this.assistantTranscript.trim() || undefined,
    });
    this.userTranscript = '';
    this.assistantTranscript = '';
  }
}
