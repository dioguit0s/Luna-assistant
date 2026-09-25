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
import { LEVEL_VALUES, type LogLevelName, type LogRecord } from '../logging/logTap.js';
import type { Diagnostics, LogFilter } from '../diagnostics/Diagnostics.js';
import { matchesFilter } from '../diagnostics/Diagnostics.js';
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
  /** Série de TTFAB, últimos erros e log ao vivo (v2). */
  diagnostics: Diagnostics;
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
/** Meta de TTFAB do projeto; o gráfico do painel traça a linha aqui. */
export const TTFAB_TARGET_MS = 800;
const MAX_LATENCY_SAMPLES = 2000;
/** Cada stream segura um socket aberto; o painel usa um só. */
const MAX_LOG_STREAMS = 4;
const SSE_HEARTBEAT_MS = 15_000;

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

    if (req.method === 'GET' && url.split('?')[0] === `${PREFIX}logs/stream`) {
      this.streamLogs(req, res, url);
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
    let segments: string[];
    try {
      segments = path
        .slice(PREFIX.length)
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, 'caminho malformado');
    }
    const method = req.method ?? 'GET';
    const [head, id, action] = segments;
    const query = new URL(url, 'http://admin.local').searchParams;

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
      case 'GET diagnostics/:id':
        if (id === 'latency') return { body: this.latency(query) };
        if (id === 'errors') return { body: this.errors(query) };
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
      devices: registry.devicesInRoom(registry.areaFor(roomId)).map((d) => ({
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
   *
   * Mas o token gravado **só** acompanha uma URL da mesma origem da gravada.
   * Sem isso, `{"url":"https://qualquer-host"}` faria o servidor mandar o
   * `HA_TOKEN` para lá — e quem tem o token admin extrairia um segredo que a
   * API jura nunca devolver (ADR 010, decisão 4).
   */
  private async testConnection(group: GroupName, body: unknown): Promise<unknown> {
    if (group !== 'ha' && group !== 'calendar') {
      throw new HttpError(404, `não há teste de conexão para "${group}"`);
    }
    const patch = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const given = (key: string): string =>
      typeof patch[key] === 'string' ? (patch[key] as string).trim() : '';

    const current = this.deps.settings.get(group);
    const url = given('url') || current.url;
    if (!url) return { ok: false, latency_ms: 0, error: 'URL e token são obrigatórios' };
    let token = given('token');
    if (!token) {
      if (!sameOrigin(url, current.url)) {
        return {
          ok: false,
          latency_ms: 0,
          error: 'URL diferente da gravada: digite o token para testar',
        };
      }
      token = current.token;
    }

    if (group === 'ha') {
      const result = await this.deps.haClient.checkConnection({ haUrl: url, haToken: token });
      return { ok: result.ok, latency_ms: result.latencyMs, error: result.error ?? null };
    }
    return this.testCalendar(url, token);
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

  // ─── Diagnóstico ───────────────────────────────────────────────────────

  /**
   * Série de TTFAB das últimas `hours` horas (padrão 24, até 30 dias) e o
   * resumo por sala × provedor. `latency_ms` é o limite inferior do intervalo
   * documentado em `metrics/ttfab.ts`; `since_turn_start_ms`, o superior.
   * Sessão fria entra na série, mas fica fora dos percentis — o custo dela é
   * de connect, não de turno, e aparece à parte em `cold`.
   */
  private latency(query: URLSearchParams): unknown {
    const hours = intParam(query, 'hours', 24, 1, 24 * 30);
    const since = this.now() - hours * 3600_000;
    const samples = this.deps.diagnostics.store.latencySince(since, MAX_LATENCY_SAMPLES);

    const groups = new Map<string, { roomId: string; provider: string; warm: number[]; cold: number }>();
    for (const s of samples) {
      const key = `${s.roomId}|${s.provider}`;
      let g = groups.get(key);
      if (!g) {
        g = { roomId: s.roomId, provider: s.provider, warm: [], cold: 0 };
        groups.set(key, g);
      }
      if (s.sessionCold) g.cold += 1;
      else g.warm.push(s.latencyMs);
    }

    return {
      target_ms: TTFAB_TARGET_MS,
      since,
      hours,
      samples: samples.map((s) => ({
        at: s.at,
        room_id: s.roomId,
        device_id: s.deviceId,
        provider: s.provider,
        latency_ms: s.latencyMs,
        since_turn_start_ms: s.sinceTurnStartMs,
        provider_wait_ms: s.providerWaitMs,
        session_cold: s.sessionCold,
      })),
      summary: [...groups.values()]
        .sort((a, b) => a.roomId.localeCompare(b.roomId) || a.provider.localeCompare(b.provider))
        .map((g) => {
          const sorted = [...g.warm].sort((a, b) => a - b);
          return {
            room_id: g.roomId,
            provider: g.provider,
            count: sorted.length,
            cold: g.cold,
            p50_ms: percentile(sorted, 0.5),
            p90_ms: percentile(sorted, 0.9),
            max_ms: sorted.length ? sorted[sorted.length - 1]! : null,
            over_target: sorted.filter((v) => v > TTFAB_TARGET_MS).length,
          };
        }),
    };
  }

  private errors(query: URLSearchParams): unknown {
    const limit = intParam(query, 'limit', 20, 1, 200);
    return {
      errors: this.deps.diagnostics.store.recentErrors(limit).map((e) => ({
        id: e.id,
        at: e.at,
        level: e.level,
        event: e.event,
        room_id: e.roomId,
        msg: e.msg,
        detail: e.detail,
      })),
    };
  }

  /**
   * Log ao vivo em Server-Sent Events: primeiro o que o buffer em memória tem
   * e passa no filtro, depois cada linha nova. `?level=` (padrão `info`) e
   * `?room=` filtram no servidor. Sem transcrição — ver `logTap.ts`.
   */
  private streamLogs(req: IncomingMessage, res: ServerResponse, url: string): void {
    const query = new URL(url, 'http://admin.local').searchParams;
    const level = query.get('level') ?? 'info';
    if (!Object.hasOwn(LEVEL_VALUES, level)) {
      send(res, 422, { error: 'nível desconhecido', field: 'level' });
      return;
    }
    const room = query.get('room');
    if (room !== null && room !== '' && !ROOM_ID_PATTERN.test(room)) {
      send(res, 422, { error: 'room_id fora do formato', field: 'room' });
      return;
    }
    if (this.deps.diagnostics.streamCount >= MAX_LOG_STREAMS) {
      send(res, 429, { error: 'streams de log demais abertos' });
      return;
    }
    const filter: LogFilter = { minLevel: level as LogLevelName, roomId: room || null };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const write = (record: LogRecord): void => {
      res.write(`id: ${record.seq}\ndata: ${JSON.stringify(logWire(record))}\n\n`);
    };
    for (const record of this.deps.diagnostics.recent(filter)) write(record);
    res.write(': ok\n\n');

    const unsubscribe = this.deps.diagnostics.onRecord((record) => {
      if (matchesFilter(record, filter)) write(record);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
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

function logWire(record: LogRecord): unknown {
  return {
    seq: record.seq,
    ts: record.ts,
    level: record.level,
    event: record.event,
    room_id: record.roomId,
    msg: record.msg,
    fields: record.fields,
  };
}

/** Percentil por posição, sobre uma lista já ordenada. `null` para lista vazia. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function intParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(422, `"${name}" deve ser inteiro entre ${min} e ${max}`, name);
  }
  return value;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
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
