import WebSocket from 'ws';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig } from '../types.js';
import { resample16kTo24k, resample24kTo16k } from '../utils/resampler.js';
import { getLogger } from '../../logging/logger.js';

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
}

export class OpenAIRealtimeAdapter implements IAudioProvider {
  private ws: WebSocket | null = null;
  private connected = false;
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private userTranscript = '';
  private assistantTranscript = '';

  constructor(private readonly config: AppConfig) {}

  async connect(sessionConfig: ProviderSessionConfig): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.openaiRealtimeModel)}`;

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.openaiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.sendEvent({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: sessionConfig.systemPrompt,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: { type: 'server_vad' },
            input_audio_transcription: { model: 'whisper-1' },
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

  onTurnComplete(callback: (turn: CompletedTurn) => void): void {
    this.turnCompleteCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  async disconnect(): Promise<void> {
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

    switch (event.type) {
      case 'response.audio.delta':
        if (event.delta) {
          const pcm24k = Buffer.from(event.delta, 'base64');
          const pcm16k = resample24kTo16k(pcm24k);
          this.audioResponseCb?.(pcm16k);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.userTranscript = event.transcript;
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          this.assistantTranscript = event.transcript;
        }
        break;

      case 'response.done':
        this.turnCompleteCb?.({
          userText: this.userTranscript.trim() || undefined,
          assistantText: this.assistantTranscript.trim() || undefined,
        });
        this.userTranscript = '';
        this.assistantTranscript = '';
        break;

      case 'error':
        this.errorCb?.(new Error(event.error?.message ?? 'Erro OpenAI Realtime'));
        break;
    }
  }
}
