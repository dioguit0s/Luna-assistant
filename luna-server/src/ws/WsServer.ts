import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../config/env.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import type { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import type { ReminderStore } from '../reminders/ReminderStore.js';
import type { WeatherSource } from '../weather/WeatherSource.js';
import type { CompassoClient } from '../calendar/CompassoClient.js';
import type { ReminderScheduler } from '../reminders/ReminderScheduler.js';
import type { AlarmRinger } from '../reminders/AlarmRinger.js';
import { validateAuthToken } from './auth.js';
import { parseBinaryMessage } from './messageParser.js';
import { normalizeRemoteAddress, parseDeviceInfo, type DeviceInfo } from './deviceInfo.js';
import type { WakeClipStore } from '../diagnostics/WakeClipStore.js';
import {
  createEnvelope,
  parseControlMessage,
  serializeControlMessage,
  type ConfigFieldResult,
  type MessageEnvelope,
  type SatelliteConfigPatch,
} from './protocol.js';
import { getLogger } from '../logging/logger.js';

interface ClientState {
  roomId: string;
  deviceId: string;
  authenticated: boolean;
  lastSeenAt: number;
  connectedAt: number;
  /** Endereço do outro lado do socket — fallback do IP sem `device_info`. */
  remoteAddress: string | null;
  /**
   * Endereço local do socket: o IP do servidor como este satélite o enxerga.
   * É o host da URL de OTA (o satélite baixa a imagem do mesmo IP do WS).
   */
  localAddress: string | null;
  /** Último `device_info` desta conexão; `null` em firmware que não manda. */
  deviceInfo: DeviceInfo | null;
}

/**
 * Eventos de OTA vindos dos satélites — implementado pelo `OtaManager`
 * (ver `src/ota/`). Interface aqui para o `WsServer` não depender da OTA.
 */
export interface OtaEvents {
  handleProgress(deviceId: string, percent: unknown): void;
  handleResult(deviceId: string, ok: unknown, error: unknown): void;
  handleDeviceInfo(deviceId: string, fwVersion: string | null, fwBuild: string | null, connectedAt: number): void;
}

/** Um satélite como o painel o vê: conectado agora ou visto desde o boot. */
export interface SatelliteInfo {
  deviceId: string;
  roomId: string;
  online: boolean;
  /** Início da conexão atual; `null` offline. */
  connectedSince: number | null;
  /** Último sinal de vida (ping, áudio, auth). */
  lastSeenAt: number;
  /**
   * Último `device_info` (versão, IP, sinal). Sobrevive à queda, para o painel
   * mostrar a última versão conhecida de um satélite offline; zera quando ele
   * reconecta, até o `device_info` novo chegar.
   */
  deviceInfo: DeviceInfo | null;
  /** Endereço remoto da última conexão. */
  remoteAddress: string | null;
}

/** Resposta do satélite a um `set_config` (ver docs/protocolo-websocket.md). */
export interface SatelliteConfigAck {
  ok: boolean;
  results: Record<string, ConfigFieldResult>;
  /** Satélite vai reconectar para a mudança valer (troca de sala). */
  reconnect: boolean;
  /** Recusa da mensagem inteira: `ocupado`, `config vazia`. */
  reason: string | null;
  /** Sala da conexão que recebeu o pedido. */
  previousRoomId: string;
}

/** Por que um `set_config` não teve resposta. */
export class SatelliteConfigError extends Error {
  constructor(
    readonly code: 'offline' | 'timeout' | 'disconnected',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Espera do `config_ack`. O firmware responde na hora (grava na NVS e manda);
 * a folga é para Wi-Fi ruim. Fica abaixo dos 5 s do cliente admin do desktop
 * (`REQUEST_TIMEOUT_MS`), senão o painel desistiria antes do servidor.
 */
export const CONFIG_ACK_TIMEOUT_MS = 3_000;

/**
 * Rota HTTP extra no mesmo servidor do `/health` — a API admin (ADR 010,
 * decisão 1). Devolve `true` quando tratou a requisição.
 */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

/**
 * Versão da release, lida do `package.json` que o deploy copia junto do
 * `dist/` (ver `deploy.yml`). Best-effort: sem o arquivo, `unknown`.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * Release implantada, gravada pelo CI em `release.json` ao lado do `dist/`
 * (ver `deploy.yml`). `null` em dev ou numa release anterior a isto.
 */
export const SERVER_RELEASE: { sha: string; deployedAt: string } | null = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL('../../release.json', import.meta.url), 'utf8')) as {
      sha?: unknown;
      deployed_at?: unknown;
    };
    return typeof raw.sha === 'string' && typeof raw.deployed_at === 'string'
      ? { sha: raw.sha, deployedAt: raw.deployed_at }
      : null;
  } catch {
    return null;
  }
})();

// O satélite manda um "ping" de aplicação a cada 10s (PING_INTERVAL_MS no
// firmware) enquanto autenticado. Uma queda abrupta — energia ou cabo USB
// arrancado — não manda close frame nenhum; sem isso, `ws` nunca dispara
// 'close' sozinho e a conexão fica "viva" para sempre do lado do servidor.
// Isso prende o cômodo com uma sessão zumbi: RoomManager mantém o provider
// (e a IA continua respondendo às falas), mas as respostas saem pelo
// `sendToClient` da conexão morta — o satélite novo, reconectado, nunca ouve
// nada. 2.5x o intervalo de ping tolera um ciclo perdido sem falso positivo.
const STALE_CONNECTION_TIMEOUT_MS = 25_000;

/** Um `ws_auth_blocked` por aparelho a cada tanto — ver `blockedLoggedAt`. */
const BLOCKED_LOG_INTERVAL_MS = 10 * 60_000;
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
  /**
   * Satélites que já autenticaram desde o boot, por `device_id` — é o que deixa
   * o painel mostrar "offline" para um aparelho que caiu. Em memória de
   * propósito: sem histórico persistido, some no restart.
   */
  private readonly seenSatellites = new Map<
    string,
    { roomId: string; lastSeenAt: number; deviceInfo: DeviceInfo | null; remoteAddress: string | null }
  >();
  /**
   * Endereço remoto por socket, gravado no 'connection' — antes da auth, que é
   * quando o `ClientState` nasce.
   */
  private readonly remoteAddresses = new WeakMap<WebSocket, string | null>();
  /** Endereço local por socket, pelo mesmo motivo — ver `ClientState.localAddress`. */
  private readonly localAddresses = new WeakMap<WebSocket, string | null>();
  private adminHandler: HttpRouteHandler | null = null;
  /** Rotas HTTP fora da API admin (a imagem de OTA), na ordem de registro. */
  private readonly httpRoutes: HttpRouteHandler[] = [];
  private otaEvents: OtaEvents | null = null;
  /** `set_config` esperando `config_ack`, por `request_id`. */
  private readonly pendingConfigs = new Map<
    string,
    {
      ws: WebSocket;
      resolve: (ack: SatelliteConfigAck) => void;
      reject: (err: SatelliteConfigError) => void;
      timer: NodeJS.Timeout;
      previousRoomId: string;
    }
  >();
  private providerName: () => string;

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
    haClient: HomeAssistantClient,
    deviceRegistry: DeviceRegistrySource,
    reminderStore: ReminderStore,
    weatherSource: WeatherSource | null,
    calendarClient: CompassoClient | null = null,
  ) {
    this.providerName = () => config.audioProvider;
    // O client do HA e o registro são construídos em `index.ts`: o registro tem
    // ciclo de vida próprio (start/stop) e ambos compartilham o mesmo client.
    this.orchestrator = new Orchestrator(
      config,
      roomManager,
      haClient,
      deviceRegistry,
      (roomId, payload) => this.sendToRoom(roomId, payload),
      reminderStore,
      weatherSource,
      calendarClient,
    );
  }

  /** Destino dos `wake_clip`. Sem ele, as partes são descartadas. */
  private wakeClipStore: WakeClipStore | null = null;

  setWakeClipStore(store: WakeClipStore): void {
    this.wakeClipStore = store;
  }

  /** Liga a API admin. Chamado antes de `start()`. */
  setAdminHandler(handler: HttpRouteHandler): void {
    this.adminHandler = handler;
  }

  /**
   * Rota HTTP extra sem o portão da API admin — hoje só a imagem de OTA
   * (`/ota/<token>.bin`), que o satélite baixa sem token admin.
   */
  addHttpRoute(handler: HttpRouteHandler): void {
    this.httpRoutes.push(handler);
  }

  /** Destino de `ota_progress`, `ota_result` e `device_info`. */
  setOtaEvents(events: OtaEvents): void {
    this.otaEvents = events;
  }

  /** Conexão autenticada e aberta mais recente do `device_id` — a que está de fato ouvindo. */
  private latestConnection(deviceId: string): { ws: WebSocket; state: ClientState } | null {
    let target: { ws: WebSocket; state: ClientState } | null = null;
    for (const [ws, state] of this.clients) {
      if (!state.authenticated || state.deviceId !== deviceId || ws.readyState !== WebSocket.OPEN) continue;
      if (!target || state.connectedAt >= target.state.connectedAt) target = { ws, state };
    }
    return target;
  }

  /** O que a OTA precisa da conexão atual do satélite; `null` offline. */
  otaConnection(deviceId: string): {
    localAddress: string | null;
    port: number | null;
    remoteAddress: string | null;
    fwVersion: string | null;
    fwBuild: string | null;
  } | null {
    const target = this.latestConnection(deviceId);
    if (!target) return null;
    const { state } = target;
    return {
      localAddress: state.localAddress,
      port: this.port,
      remoteAddress: state.remoteAddress,
      fwVersion: state.deviceInfo?.fwVersion ?? null,
      fwBuild: state.deviceInfo?.fwBuild ?? null,
    };
  }

  /** `ota_start` à conexão mais recente do satélite. `false` = não saiu. */
  sendOtaStart(deviceId: string, payload: { url: string; version: string; sha256: string; size: number }): boolean {
    const target = this.latestConnection(deviceId);
    if (!target) return false;
    try {
      target.ws.send(serializeControlMessage(createEnvelope('ota_start', target.state.roomId, payload)));
      return true;
    } catch (err) {
      getLogger().warn(
        { event: 'ota_start_send_failed', device_id: deviceId, err: err instanceof Error ? err.message : String(err) },
        'Falha ao enviar ota_start',
      );
      return false;
    }
  }

  /** `device_id`s bloqueados pelo painel — lido a cada handshake. */
  private isBlocked: (deviceId: string) => boolean = () => false;
  /**
   * Último `ws_auth_blocked` logado por aparelho. O firmware reconecta a cada
   * 2 s sem backoff depois de `auth_error`: sem limite, um satélite bloqueado
   * vira 43 mil warns por dia no journal e no log ao vivo do painel.
   */
  private readonly blockedLoggedAt = new Map<string, number>();

  setBlockedSource(source: (deviceId: string) => boolean): void {
    this.isBlocked = source;
  }

  /**
   * Fecha toda conexão deste `device_id` (painel: "desconectar", ou o
   * bloqueio recém-gravado valendo na hora). O satélite reconecta sozinho —
   * e, se bloqueado, é recusado no handshake.
   *
   * @returns quantas conexões foram fechadas.
   */
  disconnectDevice(deviceId: string, reason: string): number {
    let closed = 0;
    for (const [ws, state] of this.clients) {
      if (state.deviceId !== deviceId) continue;
      ws.close(1000, reason.slice(0, 120));
      closed += 1;
    }
    if (closed > 0) {
      getLogger().info(
        { event: 'ws_admin_disconnect', device_id: deviceId, connections: closed },
        `Satélite ${deviceId} desconectado pelo painel`,
      );
    }
    return closed;
  }

  /**
   * Manda `set_config` ao satélite conectado e espera o `config_ack`. A NVS do
   * satélite é a fonte da verdade da configuração: nada aqui é persistido.
   *
   * Com mais de uma conexão do mesmo `device_id` (a velha ainda não caiu pelo
   * reaper), vai para a mais recente — é a que está de fato ouvindo.
   *
   * Firmware anterior ao tipo ignora a mensagem: vira `timeout`.
   */
  setSatelliteConfig(
    deviceId: string,
    config: SatelliteConfigPatch,
    timeoutMs = CONFIG_ACK_TIMEOUT_MS,
  ): Promise<SatelliteConfigAck> {
    const target = this.latestConnection(deviceId);
    if (!target) {
      return Promise.reject(new SatelliteConfigError('offline', 'satélite offline'));
    }

    const { ws, state } = target;
    const requestId = randomUUID();
    return new Promise<SatelliteConfigAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConfigs.delete(requestId);
        reject(new SatelliteConfigError('timeout', `sem config_ack em ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingConfigs.set(requestId, { ws, resolve, reject, timer, previousRoomId: state.roomId });
      try {
        ws.send(
          serializeControlMessage(createEnvelope('set_config', state.roomId, { request_id: requestId, config })),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingConfigs.delete(requestId);
        reject(
          new SatelliteConfigError('disconnected', `falha ao enviar: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });
  }

  /** O `/health` mostra o provider efetivo, que o painel pode trocar a quente. */
  setProviderNameSource(source: () => string): void {
    this.providerName = source;
  }

  /** Conectados agora + vistos desde o boot, um por `device_id`. */
  listSatellites(): SatelliteInfo[] {
    const byDevice = new Map<string, SatelliteInfo>();
    for (const [deviceId, seen] of this.seenSatellites) {
      byDevice.set(deviceId, {
        deviceId,
        roomId: seen.roomId,
        online: false,
        connectedSince: null,
        lastSeenAt: seen.lastSeenAt,
        deviceInfo: seen.deviceInfo,
        remoteAddress: seen.remoteAddress,
      });
    }
    for (const state of this.clients.values()) {
      if (!state.authenticated) continue;
      byDevice.set(state.deviceId, {
        deviceId: state.deviceId,
        roomId: state.roomId,
        online: true,
        connectedSince: state.connectedAt,
        lastSeenAt: state.lastSeenAt,
        deviceInfo: state.deviceInfo,
        remoteAddress: state.remoteAddress,
      });
    }
    return [...byDevice.values()].sort((a, b) => a.roomId.localeCompare(b.roomId));
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

  /** Config de runtime lida a cada turno — ver `Orchestrator.setRuntimeConfigSource`. */
  setRuntimeConfigSource(source: () => AppConfig): void {
    this.orchestrator.setRuntimeConfigSource(source);
  }

  /** Fala de um lembrete salvo pelo painel — ver `Orchestrator.requestReminderPrerender`. */
  requestReminderPrerender(roomId: string, reminderId: number, label: string): void {
    this.orchestrator.requestReminderPrerender(roomId, reminderId, label);
  }

  cancelReminderPrerender(reminderId: number): void {
    this.orchestrator.cancelReminderPrerender(reminderId);
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
            provider: this.providerName(),
            clients: this.clients.size,
            uptime_s: Math.floor(process.uptime()),
            version: SERVER_VERSION,
          }),
        );
        return;
      }
      if (this.adminHandler?.(req, res)) return;
      for (const route of this.httpRoutes) {
        if (route(req, res)) return;
      }
      res.writeHead(404).end();
    });

    // Default do `ws` é 100MB por frame — um frame malformado (ou hostil)
    // alocaria isso tudo antes de qualquer validação. O contrato real é
    // 640 bytes de PCM + um header JSON pequeno; 64KB sobra folga generosa.
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: 64 * 1024 });

    this.wss.on('connection', (ws, req) => {
      const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
      this.remoteAddresses.set(ws, remoteAddress);
      this.localAddresses.set(ws, normalizeRemoteAddress(req.socket.localAddress));
      getLogger().info({ event: 'ws_connect', remote_address: remoteAddress }, 'Cliente WebSocket conectado');

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
    for (const ws of new Set([...this.pendingConfigs.values()].map((p) => p.ws))) {
      this.rejectPendingConfigs(ws);
    }

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
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // Stream de log do painel (SSE) é conexão ativa: sem isto, `close()`
      // esperaria o painel desistir sozinho.
      httpServer.closeAllConnections();
      await closed;
    }
  }

  private async handleMessage(
    ws: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    const state = this.clients.get(ws);
    if (state) {
      state.lastSeenAt = Date.now();
      const seen = this.seenSatellites.get(state.deviceId);
      if (seen) seen.lastSeenAt = state.lastSeenAt;
    }
    const buf = Buffer.from(data as Buffer);

    if (state?.authenticated && isBinary) {
      const parsed = parseBinaryMessage(buf);
      if (parsed && parsed.envelope.type === 'wake_clip') {
        // Material de treino, nunca áudio de turno: não passa pelo Orchestrator.
        // O `room_id` vem da autenticação, não do envelope.
        this.wakeClipStore?.addPart(state.deviceId, state.roomId, parsed.envelope, parsed.pcm);
        return;
      }
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

      case 'device_info':
        if (state?.authenticated) this.handleDeviceInfo(state, envelope);
        break;

      case 'config_ack':
        if (state?.authenticated) this.handleConfigAck(ws, state, envelope);
        break;

      case 'ota_progress':
        if (state?.authenticated) this.otaEvents?.handleProgress(state.deviceId, envelope.percent);
        break;

      case 'ota_result':
        if (state?.authenticated) {
          getLogger().info(
            { event: 'ota_result', device_id: state.deviceId, ok: envelope.ok === true, error: envelope.error },
            `Satélite ${state.deviceId}: ota_result ${envelope.ok === true ? 'ok' : `falhou (${String(envelope.error)})`}`,
          );
          this.otaEvents?.handleResult(state.deviceId, envelope.ok, envelope.error);
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

    // Depois do token: bloquear não pode virar oráculo de quais `device_id`s
    // existem para quem nem tem o segredo. Mesma mensagem e código de close de
    // qualquer auth recusada — o contrato WS (quatro cópias) não muda.
    if (this.isBlocked(device_id)) {
      const now = Date.now();
      const last = this.blockedLoggedAt.get(device_id) ?? 0;
      if (now - last >= BLOCKED_LOG_INTERVAL_MS) {
        this.blockedLoggedAt.set(device_id, now);
        getLogger().warn(
          { event: 'ws_auth_blocked', room_id, device_id },
          `Satélite bloqueado tentou conectar: ${device_id} (próximo aviso em ${BLOCKED_LOG_INTERVAL_MS / 60_000} min)`,
        );
      }
      ws.send(
        serializeControlMessage(
          createEnvelope('auth_error', room_id, { reason: 'satélite bloqueado' }),
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

    const now = Date.now();
    const remoteAddress = this.remoteAddresses.get(ws) ?? null;
    this.clients.set(ws, {
      roomId: room_id,
      deviceId: device_id,
      authenticated: true,
      lastSeenAt: now,
      connectedAt: now,
      remoteAddress,
      localAddress: this.localAddresses.get(ws) ?? null,
      deviceInfo: null,
    });
    // `deviceInfo` zera: o que valia era da conexão anterior, talvez de outro
    // firmware. Satélite antigo, que nunca manda `device_info`, fica "desconhecida".
    this.seenSatellites.set(device_id, { roomId: room_id, lastSeenAt: now, deviceInfo: null, remoteAddress });
    this.indexClient(ws, room_id);
    this.roomManager.registerClient(room_id);

    ws.send(serializeControlMessage(createEnvelope('auth_ok', room_id, { device_id })));

    getLogger().info(
      { room_id, device_id, event: 'auth_ok' },
      'Cliente autenticado',
    );
  }

  private handleDeviceInfo(
    state: ClientState,
    envelope: NonNullable<ReturnType<typeof parseControlMessage>>,
  ): void {
    const info = parseDeviceInfo(envelope, Date.now());
    state.deviceInfo = info;
    const seen = this.seenSatellites.get(state.deviceId);
    if (seen) seen.deviceInfo = info;
    getLogger().info(
      {
        event: 'device_info',
        room_id: state.roomId,
        device_id: state.deviceId,
        fw_version: info.fwVersion,
        fw_build: info.fwBuild,
        ip: info.ip,
        rssi: info.rssi,
      },
      `Satélite ${state.deviceId}: firmware ${info.fwVersion ?? '?'}+${info.fwBuild ?? '?'}, IP ${info.ip ?? state.remoteAddress ?? '?'}`,
    );
    this.otaEvents?.handleDeviceInfo(state.deviceId, info.fwVersion ?? null, info.fwBuild ?? null, state.connectedAt);
  }

  private handleConfigAck(ws: WebSocket, state: ClientState, envelope: MessageEnvelope): void {
    const requestId = typeof envelope.request_id === 'string' ? envelope.request_id : '';
    const pending = this.pendingConfigs.get(requestId);
    // Só a conexão que recebeu o pedido responde por ele: um `request_id`
    // ecoado por outro satélite não fecha o pedido alheio.
    if (!pending || pending.ws !== ws) {
      getLogger().debug({ event: 'config_ack_unmatched', device_id: state.deviceId }, 'config_ack sem pedido pendente');
      return;
    }
    clearTimeout(pending.timer);
    this.pendingConfigs.delete(requestId);
    pending.resolve(parseConfigAck(envelope, pending.previousRoomId));
  }

  /** Pedidos desta conexão não vão mais ter resposta. */
  private rejectPendingConfigs(ws: WebSocket): void {
    for (const [requestId, pending] of this.pendingConfigs) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timer);
      this.pendingConfigs.delete(requestId);
      pending.reject(new SatelliteConfigError('disconnected', 'conexão caiu antes do config_ack'));
    }
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    this.rejectPendingConfigs(ws);
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

/**
 * `config_ack` do fio → resultado tipado. Defensivo: campo de tipo errado vira
 * recusa, nunca exceção — o firmware é a única cópia do contrato sem CI.
 */
function parseConfigAck(envelope: MessageEnvelope, previousRoomId: string): SatelliteConfigAck {
  const results: Record<string, ConfigFieldResult> = {};
  const raw = envelope.results;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as { ok?: unknown; error?: unknown };
      results[key] = {
        ok: v.ok === true,
        ...(typeof v.error === 'string' ? { error: v.error.slice(0, 120) } : {}),
      };
    }
  }
  const allFieldsOk = Object.values(results).every((r) => r.ok);
  return {
    ok: envelope.ok === true && allFieldsOk,
    results,
    reconnect: envelope.reconnect === true,
    reason: typeof envelope.reason === 'string' ? envelope.reason.slice(0, 120) : null,
    previousRoomId,
  };
}
