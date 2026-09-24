import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import type { ReminderStore, Reminder } from '../reminders/ReminderStore.js';
import { spokenReminder } from '../reminders/spoken.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { WeatherSource } from '../weather/WeatherSource.js';
import type { RuntimeSettings } from '../settings/RuntimeSettings.js';
import {
  ROOM_ID_PATTERN,
  SettingsValidationError,
  maskGroup,
  type GroupName,
} from '../settings/groups.js';
import type { SatelliteInfo } from '../ws/WsServer.js';
import { SERVER_VERSION } from '../ws/WsServer.js';
import { getLogger } from '../logging/logger.js';
import { adminTokenMatches, isPrivateAddress } from './auth.js';

export interface AdminApiDeps {
  /** Config de boot: token admin e os campos de bootstrap que o painel só mostra. */
  config: AppConfig;
  settings: RuntimeSettings;
  satellites: () => SatelliteInfo[];
  deviceRegistry: DeviceRegistrySource;
  haClient: HomeAssistantClient;
  roomManager: RoomManager;
  reminderStore: ReminderStore;
  /** Cancela no banco, para o toque se estiver tocando e rearma o scheduler. */
  cancelReminder: (reminder: Reminder) => void;
  weatherSource: WeatherSource | null;
  /** Shutdown gracioso; o `Restart=always` da unit traz o processo de volta. */
  onRestart: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Semáforo por conexão, na tela Início. */
export type Light = 'ok' | 'error' | 'unknown' | 'off';

const PREFIX = '/admin/v1/';
const MAX_BODY_BYTES = 64 * 1024;
const CALENDAR_TEST_TIMEOUT_MS = 3000;

/** Grupos que o painel lê e grava inteiros pela rota genérica `settings/:grupo`. */
const EDITABLE_GROUPS = new Set<GroupName>(['ha', 'provider', 'calendar']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * API HTTP de administração do painel (ADR 010, decisão 1), no mesmo servidor
 * do `/health`. JSON sobre HTTP, sem nada específico do Electron.
 *
 * Três portões, nesta ordem:
 * 1. Sem `LUNA_ADMIN_TOKEN` a API não existe — devolve `false` e o `WsServer`
 *    responde 404, igual a qualquer rota desconhecida (falha fechada).
 * 2. Origem fora de loopback/rede privada → 403.
 * 3. Token errado → 401.
 *
 * **Nenhuma rota devolve segredo** (decisão 4): leitura mostra só "definido,
 * termina em …", escrita é só de substituição.
 */
export class AdminApi {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: AdminApiDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Assinatura de `HttpRouteHandler`: `true` quando a requisição é daqui. */
  handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = req.url ?? '';
    if (!url.startsWith('/admin/')) return false;
    if (!this.deps.config.adminToken) return false;

    if (!isPrivateAddress(req.socket.remoteAddress)) {
      getLogger().warn(
        { event: 'admin_forbidden', remote: req.socket.remoteAddress },
        'API admin chamada de fora da rede local',
      );
      send(res, 403, { error: 'somente rede local' });
      return true;
    }
    if (!adminTokenMatches(this.deps.config.adminToken, req.headers.authorization)) {
      send(res, 401, { error: 'token inválido' });
      return true;
    }

    this.route(req, url)
      .then((result) => send(res, result.status ?? 200, result.body))
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          send(res, err.status, { error: err.message, ...(err.field ? { field: err.field } : {}) });
          return;
        }
        if (err instanceof SettingsValidationError) {
          send(res, 422, { error: err.message, field: err.field });
          return;
        }
        getLogger().error(
          { event: 'admin_failed', url, err: err instanceof Error ? err.message : String(err) },
          'Falha na API admin',
        );
        send(res, 500, { error: 'erro interno' });
      });
    return true;
  };

  private async route(
    req: IncomingMessage,
    url: string,
  ): Promise<{ status?: number; body: unknown }> {
    const path = url.split('?')[0]!;
    if (!path.startsWith(PREFIX)) throw new HttpError(404, 'rota desconhecida');
    const segments = path
      .slice(PREFIX.length)
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    const method = req.method ?? 'GET';
    const [head, id, action] = segments;

    switch (`${method} ${head}${id !== undefined ? '/:id' : ''}${action !== undefined ? '/:action' : ''}`) {
      case 'GET status':
        return { body: this.status() };
      case 'GET bootstrap':
        return { body: this.bootstrap() };
      case 'GET satellites':
        return { body: { satellites: this.satellites() } };
      case 'PUT satellites/:id':
        return { body: this.renameSatellite(id!, await readJson(req)) };
      case 'GET rooms':
        return { body: this.rooms() };
      case 'PUT rooms/:id':
        return { body: this.mapRoom(id!, await readJson(req)) };
      case 'GET devices':
        return { body: this.devices() };
      case 'PUT devices':
        return { body: this.updateAliases(await readJson(req)) };
      case 'GET reminders':
        return { body: { reminders: this.reminders() } };
      case 'DELETE reminders/:id':
        return { body: this.cancelReminder(id!) };
      case 'GET settings/:id':
        return { body: this.readSettings(editableGroup(id!)) };
      case 'PUT settings/:id':
        return { body: this.writeSettings(editableGroup(id!), await readJson(req)) };
      case 'POST settings/:id/:action':
        if (action === 'test') return { body: await this.testConnection(editableGroup(id!), await readJson(req)) };
        break;
      case 'POST restart':
        return { status: 202, body: this.restart() };
    }
    throw new HttpError(404, 'rota desconhecida');
  }

  // ─── Início ────────────────────────────────────────────────────────────

  private status(): unknown {
    const now = this.now();
    const satellites = this.deps.satellites();
    return {
      version: SERVER_VERSION,
      uptime_s: Math.floor(process.uptime()),
      started_at: now - Math.floor(process.uptime() * 1000),
      satellites_online: satellites.filter((s) => s.online).length,
      connections: {
        ha: this.haLight(),
        provider: this.providerLight(),
        weather: this.weatherLight(),
        calendar: this.calendarLight(),
      },
      next_reminders: this.reminders().slice(0, 5),
    };
  }

  private haLight(): { light: Light; detail: string } {
    const { url, token } = this.deps.settings.get('ha');
    if (!url || !token) return { light: 'off', detail: 'não configurado' };
    const last = this.deps.deviceRegistry.refreshStatus();
    if (last.ok === null) return { light: 'unknown', detail: 'ainda não consultado' };
    return last.ok
      ? { light: 'ok', detail: `${this.deps.deviceRegistry.current().size} dispositivos` }
      : { light: 'error', detail: 'última descoberta falhou' };
  }

  private providerLight(): { light: Light; detail: string } {
    const provider = this.deps.settings.get('provider');
    const last = this.deps.roomManager.lastConnectStatus();
    const name = provider.provider === 'gemini' ? 'Gemini' : 'OpenAI';
    if (!last) return { light: 'unknown', detail: `${name}: nenhuma sessão aberta desde o boot` };
    return last.ok
      ? { light: 'ok', detail: `${name}: última sessão abriu` }
      : { light: 'error', detail: `${name}: ${last.error ?? 'falha ao abrir sessão'}` };
  }

  private weatherLight(): { light: Light; detail: string } {
    if (!this.deps.weatherSource) return { light: 'off', detail: 'sem localização configurada' };
    return this.deps.weatherSource.current()
      ? { light: 'ok', detail: 'previsão em dia' }
      : { light: 'error', detail: 'sem previsão recente' };
  }

  private calendarLight(): { light: Light; detail: string } {
    const { url } = this.deps.settings.get('calendar');
    // Sem as tools da agenda (TODO da API do app), "configurado" é o máximo
    // que dá para afirmar sem fazer uma requisição a cada status.
    return url
      ? { light: 'unknown', detail: 'configurado — use "testar conexão"' }
      : { light: 'off', detail: 'não configurado' };
  }

  // ─── Satélites ─────────────────────────────────────────────────────────

  private satellites(): unknown[] {
    const { names } = this.deps.settings.get('satellites');
    const listed = this.deps.satellites();
    const known = new Set(listed.map((s) => s.deviceId));
    // Satélite com nome dado pelo painel mas não visto desde o boot continua
    // na lista — offline e sem sala, que é tudo que se sabe dele.
    const offlineNamed = Object.keys(names)
      .filter((deviceId) => !known.has(deviceId))
      .map((deviceId) => ({
        deviceId,
        roomId: null,
        online: false,
        connectedSince: null,
        lastSeenAt: null,
      }));
    return [...listed, ...offlineNamed].map((s) => ({
      device_id: s.deviceId,
      room_id: s.roomId,
      name: names[s.deviceId] ?? null,
      online: s.online,
      connected_since: s.connectedSince,
      last_seen_at: s.lastSeenAt,
    }));
  }

  private renameSatellite(deviceId: string, body: unknown): unknown {
    const name = field(body, 'name');
    const names = { ...this.deps.settings.get('satellites').names };
    if (name === null || (typeof name === 'string' && name.trim() === '')) {
      delete names[deviceId];
    } else if (typeof name === 'string') {
      names[deviceId] = name;
    } else {
      throw new HttpError(422, '"name" deve ser texto ou null', 'name');
    }
    this.deps.settings.update('satellites', { names });
    return { device_id: deviceId, name: names[deviceId] ?? null };
  }

  // ─── Salas e dispositivos ──────────────────────────────────────────────

  private rooms(): unknown {
    const registry = this.deps.deviceRegistry.current();
    const { areas } = this.deps.settings.get('rooms');
    const haAreas = registry.rooms;
    const satelliteRooms = new Set(
      this.deps.satellites().map((s) => s.roomId),
    );

    const all = new Set([...satelliteRooms, ...haAreas, ...Object.keys(areas)]);
    const rooms = [...all].sort().map((roomId) => ({
      room_id: roomId,
      has_satellite: satelliteRooms.has(roomId),
      is_ha_area: haAreas.includes(roomId),
      area: areas[roomId] ?? null,
      effective_area: registry.areaFor(roomId),
      // O mesmo que `list_devices` responderia nesta sala (ADR 009): nomes,
      // sem estado e sem I/O.
      devices: registry.devicesInRoom(roomId).map((d) => ({
        device: d.device,
        name: d.name ?? null,
        entity_id: d.entityId,
      })),
    }));

    return { rooms, ha_areas: haAreas };
  }

  private mapRoom(roomId: string, body: unknown): unknown {
    if (!ROOM_ID_PATTERN.test(roomId)) throw new HttpError(422, 'room_id fora do formato', 'room_id');
    const area = field(body, 'area');
    const areas = { ...this.deps.settings.get('rooms').areas };
    if (area === null || area === '' || area === roomId) {
      delete areas[roomId];
    } else if (typeof area === 'string') {
      areas[roomId] = area;
    } else {
      throw new HttpError(422, '"area" deve ser texto ou null', 'area');
    }
    this.deps.settings.update('rooms', { areas });
    return { room_id: roomId, area: areas[roomId] ?? null };
  }

  private devices(): unknown {
    const overrides = this.deps.settings.get('devices');
    return {
      aliases: overrides.aliases,
      exclude: overrides.exclude,
      devices: overrides.devices.map((d) => ({
        device: d.device,
        room_id: d.roomId,
        entity_id: d.entityId,
        name: d.name ?? null,
      })),
    };
  }

  /** v1 edita só os apelidos; exclusões e entradas manuais são v2. */
  private updateAliases(body: unknown): unknown {
    const aliases = field(body, 'aliases');
    if (aliases === undefined) throw new HttpError(422, '"aliases" é obrigatório', 'aliases');
    this.deps.settings.update('devices', { aliases });
    return this.devices();
  }

  // ─── Lembretes ─────────────────────────────────────────────────────────

  private reminders(): unknown[] {
    const now = new Date(this.now());
    return this.deps.reminderStore.listLive().map((r) => ({
      id: r.id,
      short_id: r.shortId,
      room_id: r.roomId,
      label: r.label,
      kind: r.kind,
      repeat_rule: r.repeatRule,
      next_due_utc: r.nextDueUtc,
      status: r.status,
      spoken: spokenReminder(r, now),
    }));
  }

  private cancelReminder(rawId: string): unknown {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(422, 'id inválido', 'id');
    const reminder = this.deps.reminderStore.get(id);
    if (!reminder || (reminder.status !== 'armed' && reminder.status !== 'ringing')) {
      throw new HttpError(404, 'lembrete não encontrado ou já encerrado');
    }
    this.deps.cancelReminder(reminder);
    getLogger().info(
      { event: 'reminder_cancelled', room_id: reminder.roomId, short_id: reminder.shortId, via: 'admin' },
      `Lembrete ${reminder.shortId} cancelado pelo painel`,
    );
    return { id, cancelled: true };
  }

  // ─── Integrações ───────────────────────────────────────────────────────

  private readSettings(group: GroupName): unknown {
    return {
      group,
      value: maskGroup(group, this.deps.settings.get(group)),
      updated_at: this.deps.settings.updatedAt(group),
      applies: group === 'provider' ? 'next_session' : 'immediate',
    };
  }

  private writeSettings(group: GroupName, body: unknown): unknown {
    this.deps.settings.update(group, body);
    return this.readSettings(group);
  }

  /**
   * Testa com o que veio no corpo, completando com o que está gravado — dá
   * para testar uma URL nova sem redigitar o token.
   */
  private async testConnection(group: GroupName, body: unknown): Promise<unknown> {
    const patch = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const pick = (key: string, current: string): string =>
      typeof patch[key] === 'string' && (patch[key] as string).trim() !== ''
        ? (patch[key] as string).trim()
        : current;

    if (group === 'ha') {
      const current = this.deps.settings.get('ha');
      const result = await this.deps.haClient.checkConnection({
        haUrl: pick('url', current.url),
        haToken: pick('token', current.token),
      });
      return { ok: result.ok, latency_ms: result.latencyMs, error: result.error ?? null };
    }

    if (group === 'calendar') {
      const current = this.deps.settings.get('calendar');
      return this.testCalendar(pick('url', current.url), pick('token', current.token));
    }

    throw new HttpError(404, `não há teste de conexão para "${group}"`);
  }

  /**
   * Provisório até a API do app de agendas existir (TODO em
   * `docs/painel-de-controle.md`): só prova que a URL responde e aceita o
   * token. Quando houver rota de saúde, é ela que entra aqui.
   */
  private async testCalendar(url: string, token: string): Promise<unknown> {
    if (!url) return { ok: false, latency_ms: 0, error: 'URL não configurada' };
    const startedAt = Date.now();
    try {
      const res = await this.fetchImpl(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(CALENDAR_TEST_TIMEOUT_MS),
      });
      const latency = Date.now() - startedAt;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, latency_ms: latency, error: 'credencial recusada' };
      }
      return res.status < 500
        ? { ok: true, latency_ms: latency, error: null }
        : { ok: false, latency_ms: latency, error: `HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : 'erro desconhecido',
      };
    }
  }

  // ─── Servidor ──────────────────────────────────────────────────────────

  private bootstrap(): unknown {
    const { config } = this.deps;
    // Só leitura, e sem segredo: o painel mostra, quem muda é o `.env`.
    return {
      ws_port: config.wsPort,
      db_path: config.dbPath,
      log_level: config.logLevel,
      devices_config_path: config.devicesConfigPath,
      ws_auth_secret: { set: Boolean(config.wsAuthSecret), last4: null },
      admin_token: { set: Boolean(config.adminToken), last4: null },
      version: SERVER_VERSION,
    };
  }

  private restart(): unknown {
    getLogger().warn({ event: 'admin_restart' }, 'Reinício pedido pelo painel');
    // Depois de a resposta sair: o shutdown fecha o servidor HTTP.
    setTimeout(() => this.deps.onRestart(), 200).unref();
    return { restarting: true };
  }
}

function editableGroup(id: string): GroupName {
  if (!EDITABLE_GROUPS.has(id as GroupName)) throw new HttpError(404, `grupo "${id}" desconhecido`);
  return id as GroupName;
}

function field(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(422, 'corpo deve ser um objeto JSON');
  }
  return (body as Record<string, unknown>)[key];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'corpo grande demais');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
