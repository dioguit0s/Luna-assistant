// Cliente WebSocket do luna-desktop: o que o luna-client-test não precisava
// ter (ele roda uma vez e sai) — reconexão com backoff, ping de keep-alive e
// eventos tipados para a máquina de estados (session.ts) consumir.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { computeAuthToken } from './auth.js';
import {
  createEnvelope,
  parseControlMessage,
  parseIncomingMessage,
  serializeControlMessage,
  buildAudioMessage,
  type MessageEnvelope,
} from './protocol.js';

// O reaper do servidor derruba conexões silenciosas há mais de 25s
// (STALE_CONNECTION_TIMEOUT_MS). Com o uplink pausado durante thinking/
// speaking, só o ping garante que a conexão sobrevive a uma resposta longa.
const PING_INTERVAL_MS = 10_000;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Secret errado não se corrige sozinho: reconectar rápido depois de um
// auth_error só spammaria o servidor e o log. Fixo no teto do backoff normal.
const AUTH_ERROR_BACKOFF_MS = BACKOFF_MAX_MS;

export interface LunaWsClientOptions {
  serverUrl: string;
  roomId: string;
  authSecret: string;
  deviceId: string;
}

export interface LunaWsClientEvents {
  connecting: () => void;
  authOk: () => void;
  authError: (reason: string | undefined) => void;
  control: (envelope: MessageEnvelope) => void;
  audio: (envelope: MessageEnvelope, pcm: Buffer) => void;
  closed: (info: { code: number; reason: string; wasAuthError: boolean }) => void;
  reconnectScheduled: (delayMs: number) => void;
}

export declare interface LunaWsClient {
  on<K extends keyof LunaWsClientEvents>(event: K, listener: LunaWsClientEvents[K]): this;
  emit<K extends keyof LunaWsClientEvents>(
    event: K,
    ...args: Parameters<LunaWsClientEvents[K]>
  ): boolean;
}

export class LunaWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private stopped = false;
  // Setado por handleTextEnvelope ao receber auth_error, lido (e limpo) pelo
  // listener de 'close' do mesmo socket — o close sempre segue o auth_error
  // (o servidor manda um e depois fecha com 4001), nunca sobrevive a uma
  // reconexão, então uma única flag de instância basta.
  private lastAuthError = false;

  constructor(private readonly opts: LunaWsClientOptions) {
    super();
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Inicia a conexão (e o ciclo de reconexão automática até stop()). */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Encerra de vez — usado no app.quit(). Não reconecta depois disso. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    this.authenticated = false;
  }

  /** Envia um frame de áudio se — e só se — autenticado. seq incrementa antes de ler (1º chunk = 1), como no luna-client-test. */
  sendAudio(pcm: Buffer): void {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq++;
    this.ws.send(buildAudioMessage(this.opts.roomId, this.seq, pcm));
  }

  private connect(): void {
    this.emit('connecting');
    const ws = new WebSocket(this.opts.serverUrl);
    this.ws = ws;

    ws.on('open', () => {
      const token = computeAuthToken(this.opts.authSecret, this.opts.deviceId);
      ws.send(
        serializeControlMessage(
          createEnvelope('auth', this.opts.roomId, { device_id: this.opts.deviceId, token }),
        ),
      );
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const envelope = parseControlMessage(Buffer.from(data as Buffer).toString('utf8'));
        if (!envelope) return;
        this.handleTextEnvelope(envelope);
        return;
      }

      const parsed = parseIncomingMessage(Buffer.from(data as Buffer));
      if (!parsed) return;
      if (parsed.envelope.type === 'audio_response') {
        this.emit('audio', parsed.envelope, parsed.pcm);
      } else {
        this.emit('control', parsed.envelope);
      }
    });

    ws.on('close', (code, reasonBuf) => {
      this.stopPing();
      this.authenticated = false;
      if (this.ws !== ws) return; // socket antigo já substituído — ignora eco de close
      this.ws = null;
      const wasAuthError = this.lastAuthError;
      this.lastAuthError = false;
      this.emit('closed', { code, reason: reasonBuf.toString('utf8'), wasAuthError });
      this.scheduleReconnect(wasAuthError);
    });

    ws.on('error', (err) => {
      // 'close' sempre segue 'error' no ws — não duplica o reconnect aqui, só loga.
      console.error(`[luna-desktop] erro WebSocket: ${err.message}`);
    });
  }

  private handleTextEnvelope(envelope: MessageEnvelope): void {
    if (envelope.type === 'auth_ok') {
      this.authenticated = true;
      this.backoffMs = BACKOFF_INITIAL_MS; // reconexão saudável reseta o backoff
      this.startPing();
      this.emit('authOk');
      return;
    }

    if (envelope.type === 'auth_error') {
      this.lastAuthError = true;
      this.emit('authError', envelope.reason);
      return;
    }

    this.emit('control', envelope);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
        this.ws.send(serializeControlMessage(createEnvelope('ping', this.opts.roomId)));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(wasAuthError: boolean): void {
    if (this.stopped) return;

    const delay = wasAuthError ? AUTH_ERROR_BACKOFF_MS : this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);

    // Jitter de ±20% evita que múltiplas instâncias (ex.: dev + prod na mesma
    // máquina) martelem o servidor no mesmo instante depois de uma queda.
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    const delayMs = Math.max(250, Math.round(delay + jitter));

    this.emit('reconnectScheduled', delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delayMs);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
