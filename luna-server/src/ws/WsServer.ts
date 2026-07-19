import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../config/env.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import { validateAuthToken } from './auth.js';
import { parseAudioMessage } from './messageParser.js';
import {
  createEnvelope,
  parseControlMessage,
  serializeControlMessage,
} from './protocol.js';
import { getLogger } from '../logging/logger.js';

interface ClientState {
  roomId: string;
  deviceId: string;
  authenticated: boolean;
}

export class WsServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly orchestrator: Orchestrator;

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
  ) {
    this.orchestrator = new Orchestrator(config, roomManager);
  }

  start(): void {
    // Servidor HTTP próprio para expor GET /health ao lado do WebSocket.
    // O deploy usa esse endpoint para validar a release antes de efetivá-la.
    this.httpServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            provider: this.config.audioProvider,
            clients: this.clients.size,
            uptime_s: Math.floor(process.uptime()),
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws) => {
      getLogger().info({ event: 'ws_connect' }, 'Cliente WebSocket conectado');

      ws.on('message', (data, isBinary) => {
        void this.handleMessage(ws, data, isBinary);
      });

      ws.on('close', () => {
        void this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        getLogger().error({ err: err.message }, 'Erro WebSocket');
      });
    });

    this.httpServer.listen(this.config.wsPort);

    getLogger().info({ port: this.config.wsPort, event: 'ws_listen' }, 'Servidor WebSocket ativo');
  }

  /** Porta efetivamente aberta. Difere de config.wsPort quando ela é 0 (testes). */
  get port(): number | null {
    const addr = this.httpServer?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  async stop(): Promise<void> {
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;

    const httpServer = this.httpServer;
    this.httpServer = null;
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }

  private async handleMessage(
    ws: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    const state = this.clients.get(ws);
    const buf = Buffer.from(data as Buffer);

    if (state?.authenticated && isBinary) {
      const parsed = parseAudioMessage(buf);
      if (parsed && parsed.pcm.length > 0) {
        await this.orchestrator.handleAudioChunk(
          state.roomId,
          state.deviceId,
          parsed.pcm,
          (payload) => ws.send(payload),
        );
        return;
      }

      if (buf[0] !== 0x7b) {
        await this.orchestrator.handleAudioChunk(
          state.roomId,
          state.deviceId,
          buf,
          (payload) => ws.send(payload),
        );
        return;
      }
    }

    const raw = buf.toString('utf8');
    const envelope = parseControlMessage(raw);
    if (!envelope) {
      getLogger().warn({ event: 'invalid_message' }, 'Mensagem JSON inválida');
      return;
    }

    switch (envelope.type) {
      case 'auth':
        this.handleAuth(ws, envelope);
        break;

      case 'ping':
        if (state?.authenticated) {
          ws.send(serializeControlMessage(createEnvelope('pong', envelope.room_id)));
        }
        break;

      default:
        getLogger().debug({ type: envelope.type }, 'Mensagem de controle ignorada');
    }
  }

  private handleAuth(
    ws: WebSocket,
    envelope: NonNullable<ReturnType<typeof parseControlMessage>>,
  ): void {
    const { room_id, device_id, token } = envelope;

    if (!device_id || !token) {
      ws.send(
        serializeControlMessage(
          createEnvelope('auth_error', room_id, { reason: 'device_id e token obrigatórios' }),
        ),
      );
      ws.close(4001, 'Auth inválida');
      return;
    }

    if (!validateAuthToken(this.config.wsAuthSecret, device_id, token)) {
      ws.send(
        serializeControlMessage(
          createEnvelope('auth_error', room_id, { reason: 'token inválido' }),
        ),
      );
      ws.close(4001, 'Auth inválida');
      return;
    }

    this.clients.set(ws, { roomId: room_id, deviceId: device_id, authenticated: true });
    this.roomManager.registerClient(room_id);

    ws.send(serializeControlMessage(createEnvelope('auth_ok', room_id, { device_id })));

    getLogger().info(
      { room_id, device_id, event: 'auth_ok' },
      'Cliente autenticado',
    );
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = this.clients.get(ws);
    if (state) {
      await this.roomManager.unregisterClient(state.roomId);
      getLogger().info(
        { room_id: state.roomId, device_id: state.deviceId, event: 'ws_disconnect' },
        'Cliente desconectado',
      );
    }
    this.clients.delete(ws);
  }
}
