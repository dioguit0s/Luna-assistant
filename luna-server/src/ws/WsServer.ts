import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../config/env.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import type { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import type { ReminderStore } from '../reminders/ReminderStore.js';
import type { ReminderScheduler } from '../reminders/ReminderScheduler.js';
import type { AlarmRinger } from '../reminders/AlarmRinger.js';
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
  lastSeenAt: number;
}

// O satélite manda um "ping" de aplicação a cada 10s (PING_INTERVAL_MS no
// firmware) enquanto autenticado. Uma queda abrupta — energia ou cabo USB
// arrancado — não manda close frame nenhum; sem isso, `ws` nunca dispara
// 'close' sozinho e a conexão fica "viva" para sempre do lado do servidor.
// Isso prende o cômodo com uma sessão zumbi: RoomManager mantém o provider
// (e a IA continua respondendo às falas), mas as respostas saem pelo
// `sendToClient` da conexão morta — o satélite novo, reconectado, nunca ouve
// nada. 2.5x o intervalo de ping tolera um ciclo perdido sem falso positivo.
const STALE_CONNECTION_TIMEOUT_MS = 25_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

// Teto para o handshake de auth: sem isto, um socket que conecta e nunca
// manda "auth" (bug de firmware, teste manual, cliente malicioso) fica
// pendurado para sempre — `reapStaleConnections` só varre `clients`, que só
// ganha entrada DEPOIS da auth bem-sucedida, então esse socket é invisível
// ao reaper de conexões zumbis.
const AUTH_TIMEOUT_MS = 10_000;

// Vocabulário de room_id: mesmo formato do area_id do Home Assistant (ver
// ROOM_LABELS em luna-system-prompt.ts) — minúsculas, dígitos e underscore.
// room_id vira chave em vários mapas do Orchestrator/RoomManager; sem este
// teto de formato/tamanho, um valor arbitrário do envelope de auth (nunca
// validado antes) entraria direto nessas estruturas.
const ROOM_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

export class WsServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clients = new Map<WebSocket, ClientState>();
  // Índice de cômodo → satélites conectados nele. Os membros são os próprios
  // sockets, não `device_id`: dois satélites no mesmo cômodo são duas conexões
  // distintas, e chavear por `device_id` colapsaria os dois numa entrada só —
  // exatamente o bug que este índice existe para corrigir. Sempre espelho de
  // `clients`, mantido nos mesmos três pontos (auth, re-auth, disconnect).
  private readonly clientsByRoom = new Map<string, Set<WebSocket>>();
  private readonly pendingAuthTimers = new Map<WebSocket, NodeJS.Timeout>();
  private readonly orchestrator: Orchestrator;

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
    haClient: HomeAssistantClient,
    deviceRegistry: DeviceRegistrySource,
    reminderStore: ReminderStore,
  ) {
    // O client do HA e o registro são construídos em `index.ts`: o registro tem
    // ciclo de vida próprio (start/stop) e ambos compartilham o mesmo client.
    this.orchestrator = new Orchestrator(
      config,
      roomManager,
      haClient,
      deviceRegistry,
      (roomId, payload) => this.sendToRoom(roomId, payload),
      reminderStore,
    );
  }

  /**
   * Passthrough para `Orchestrator.setReminderScheduler`: `index.ts` chama
   * isto depois de `start()`, quando o `ReminderScheduler` já existe (ver o
   * comentário lá — nenhum dos dois pode nascer primeiro). O Orchestrator
   * continua um detalhe de implementação do `WsServer`, então nada aqui expõe
   * a instância inteira.
   */
  setReminderScheduler(scheduler: ReminderScheduler): void {
    this.orchestrator.setReminderScheduler(scheduler);
  }

  /**
   * Passthrough para `Orchestrator.ringOnce`: toca o chime uma vez no cômodo.
   * Uma rajada só, sem ciclo — o toque de verdade é o `AlarmRinger`.
   */
  ringOnce(roomId: string): number {
    return this.orchestrator.ringOnce(roomId);
  }

  /**
   * O ciclo de toque por sala, para `index.ts` ligar no `onFire` do
   * `ReminderScheduler` e parar no shutdown. O Orchestrator continua um
   * detalhe de implementação do `WsServer`; só o ringer sai.
   */
  getAlarmRinger(): AlarmRinger {
    return this.orchestrator.getAlarmRinger();
  }

  /**
   * Fan-out de um payload para todos os satélites autenticados de um cômodo.
   * Único caminho de saída endereçado por sala — o Orchestrator não guarda
   * mais conexão nenhuma.
   *
   * Devolve quantos satélites de fato receberam: um cômodo sem ninguém
   * conectado devolve 0, que é o sinal de "sala muda" de que o disparo de
   * alarme vai precisar.
   *
   * Uma conexão zumbi (queda de energia, cabo arrancado — não manda close
   * frame) continua no índice e continua contando aqui até o
   * `reapStaleConnections` derrubá-la, no teto de STALE_CONNECTION_TIMEOUT_MS.
   * Isso é de propósito: quem decide o que é conexão viva é o reaper, num
   * lugar só, e o satélite que está de fato ouvindo recebe tudo do mesmo jeito.
   */
  sendToRoom(roomId: string, payload: Buffer | string): number {
    const sockets = this.clientsByRoom.get(roomId);
    if (!sockets) return 0;

    let delivered = 0;
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
        delivered += 1;
      } catch (err) {
        // Um socket morto não pode calar os outros satélites do cômodo: o
        // 'close' dele chega depois e o tira do índice sozinho.
        getLogger().warn(
          {
            err: err instanceof Error ? err.message : String(err),
            room_id: roomId,
            event: 'ws_send_failed',
          },
          'Falha ao enviar para um satélite do cômodo',
        );
      }
    }

    return delivered;
  }

  private indexClient(ws: WebSocket, roomId: string): void {
    let sockets = this.clientsByRoom.get(roomId);
    if (!sockets) {
      sockets = new Set();
      this.clientsByRoom.set(roomId, sockets);
    }
    sockets.add(ws);
  }

  /** Remove a entrada e o próprio cômodo quando ele fica sem satélites. */
  private deindexClient(ws: WebSocket, roomId: string): void {
    const sockets = this.clientsByRoom.get(roomId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.clientsByRoom.delete(roomId);
    }
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

    // Default do `ws` é 100MB por frame — um frame malformado (ou hostil)
    // alocaria isso tudo antes de qualquer validação. O contrato real é
    // 640 bytes de PCM + um header JSON pequeno; 64KB sobra folga generosa.
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: 64 * 1024 });

    this.wss.on('connection', (ws) => {
      getLogger().info({ event: 'ws_connect' }, 'Cliente WebSocket conectado');

      this.pendingAuthTimers.set(
        ws,
        setTimeout(() => {
          this.pendingAuthTimers.delete(ws);
          getLogger().warn(
            { event: 'ws_auth_timeout' },
            `Sem "auth" em ${AUTH_TIMEOUT_MS}ms: encerrando conexão`,
          );
          ws.terminate();
        }, AUTH_TIMEOUT_MS),
      );

      ws.on('message', (data, isBinary) => {
        this.handleMessage(ws, data, isBinary).catch((err) => {
          // Qualquer rejeição aqui (provider inacessível, socket já fechado,
          // etc.) não pode derrubar o processo inteiro — sob Node 22 uma
          // unhandledRejection mata todos os cômodos, não só este. Degrada
          // só esta conexão: fecha para o satélite reconectar e reautenticar
          // (StateMachine::reset() no onAuthOk do firmware limpa o resto).
          getLogger().error(
            { err: err instanceof Error ? err.message : String(err), event: 'ws_message_failed' },
            'Falha ao processar mensagem WebSocket',
          );
          ws.close(1011, 'Erro interno');
        });
      });

      ws.on('close', () => {
        this.clearAuthTimeout(ws);
        this.handleDisconnect(ws).catch((err) => {
          getLogger().error(
            { err: err instanceof Error ? err.message : String(err), event: 'ws_disconnect_failed' },
            'Falha ao encerrar sessão da sala no disconnect',
          );
        });
      });

      ws.on('error', (err) => {
        getLogger().error({ err: err.message }, 'Erro WebSocket');
      });
    });

    this.httpServer.listen(this.config.wsPort);

    this.staleCheckTimer = setInterval(() => this.reapStaleConnections(), STALE_CHECK_INTERVAL_MS);

    getLogger().info({ port: this.config.wsPort, event: 'ws_listen' }, 'Servidor WebSocket ativo');
  }

  /**
   * `ws.terminate()`, não `close()`: força o encerramento do socket e dispara
   * 'close' de imediato, liberando a sala (RoomManager.unregisterClient) sem
   * esperar um handshake que uma conexão morta nunca vai mandar.
   */
  private reapStaleConnections(): void {
    const now = Date.now();
    for (const [ws, state] of this.clients) {
      if (state.authenticated && now - state.lastSeenAt > STALE_CONNECTION_TIMEOUT_MS) {
        getLogger().warn(
          { room_id: state.roomId, device_id: state.deviceId, event: 'ws_stale_disconnect' },
          `Conexão sem sinal de vida há mais de ${STALE_CONNECTION_TIMEOUT_MS}ms: encerrando`,
        );
        ws.terminate();
      }
    }
  }

  private clearAuthTimeout(ws: WebSocket): void {
    const timer = this.pendingAuthTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.pendingAuthTimers.delete(ws);
    }
  }

  /** Porta efetivamente aberta. Difere de config.wsPort quando ela é 0 (testes). */
  get port(): number | null {
    const addr = this.httpServer?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  async stop(): Promise<void> {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const timer of this.pendingAuthTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingAuthTimers.clear();

    // `terminate()`, não `close()`: um satélite que não responde ao handshake
    // de close (Wi-Fi degradado, já sem energia) faria `httpServer.close()`
    // esperar por uma conexão que nunca vai fechar sozinha — até o teto do
    // `ws` (closeTimeout, ~30s), tempo de sobra para o systemd mandar SIGKILL
    // antes do shutdown gracioso terminar.
    for (const ws of this.clients.keys()) {
      ws.terminate();
    }
    this.clients.clear();
    this.clientsByRoom.clear();
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
    if (state) state.lastSeenAt = Date.now();
    const buf = Buffer.from(data as Buffer);

    if (state?.authenticated && isBinary) {
      const parsed = parseAudioMessage(buf);
      if (parsed && parsed.pcm.length > 0) {
        await this.orchestrator.handleAudioChunk(state.roomId, state.deviceId, parsed.pcm);
        return;
      }

      if (buf[0] !== 0x7b) {
        await this.orchestrator.handleAudioChunk(state.roomId, state.deviceId, buf);
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

      case 'activity_end':
        if (state?.authenticated) {
          await this.orchestrator.handleActivityEnd(state.roomId);
        }
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
    // Recebeu "auth" (válido ou não): o handshake aconteceu, não é mais um
    // socket zumbi que nunca fala nada.
    this.clearAuthTimeout(ws);

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

    if (!ROOM_ID_PATTERN.test(room_id)) {
      ws.send(
        serializeControlMessage(
          createEnvelope('auth_error', room_id, { reason: 'room_id fora do formato esperado' }),
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

    // Re-auth no mesmo socket: o firmware manda um único "auth" por conexão
    // (ver LunaWsClient.cpp), então isto não deveria disparar no fluxo normal
    // — mas sem a guarda, um segundo "auth" levaria `registerClient` a
    // incrementar o refcount para 2 sem um `unregisterClient` correspondente,
    // prendendo a sessão paga do provider até o restart do processo (o único
    // disconnect deste socket derrubaria o refcount só para 1).
    const previous = this.clients.get(ws);
    if (previous) {
      this.deindexClient(ws, previous.roomId);
      this.roomManager
        .unregisterClient(previous.roomId)
        .then((roomDestroyed) => {
          if (roomDestroyed) this.orchestrator.releaseRoom(previous.roomId);
        })
        .catch((err) => {
          getLogger().error(
            {
              err: err instanceof Error ? err.message : String(err),
              room_id: previous.roomId,
              event: 'ws_reauth_unregister_failed',
            },
            'Falha ao liberar a sala anterior num re-auth no mesmo socket',
          );
        });
    }

    this.clients.set(ws, {
      roomId: room_id,
      deviceId: device_id,
      authenticated: true,
      lastSeenAt: Date.now(),
    });
    this.indexClient(ws, room_id);
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
      // Antes de qualquer await: `releaseRoom` e o drain de áudio pendente não
      // podem enxergar um socket que já foi embora.
      this.deindexClient(ws, state.roomId);
      const roomDestroyed = await this.roomManager.unregisterClient(state.roomId);
      // Só libera o estado por sala do Orchestrator (speakingByRoom, timers,
      // fila de áudio) quando este era de fato o último cliente da sala — com
      // outro satélite ainda conectado na mesma sala, apagar essa memória
      // agora derrubaria o `speaking_start`/`speaking_end` de que ele depende
      // e cortaria a resposta em curso no meio.
      if (roomDestroyed) {
        this.orchestrator.releaseRoom(state.roomId);
      }
      getLogger().info(
        { room_id: state.roomId, device_id: state.deviceId, event: 'ws_disconnect' },
        'Cliente desconectado',
      );
    }
    this.clients.delete(ws);
  }
}
