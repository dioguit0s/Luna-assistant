import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import { ReminderStore } from '../reminders/ReminderStore.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { RuntimeSettings } from '../settings/RuntimeSettings.js';
import { WsServer } from '../ws/WsServer.js';
import { AdminApi } from './AdminApi.js';
import { Diagnostics } from '../diagnostics/Diagnostics.js';
import { DiagnosticsStore } from '../diagnostics/DiagnosticsStore.js';
import type { LogRecord } from '../logging/logTap.js';
import { adminTokenMatches, isPrivateAddress } from './auth.js';
import WebSocket from 'ws';
import { computeAuthToken } from '../ws/auth.js';
import { createEnvelope, serializeControlMessage } from '../ws/protocol.js';
import { createHash } from 'node:crypto';
import { FirmwareReleases } from '../ota/firmwareReleases.js';
import { OtaManager } from '../ota/OtaManager.js';
import type { CompassoItem, CompassoList, CompassoResult } from '../calendar/CompassoClient.js';
import { MAX_SPOKEN_ITEMS } from '../calendar/agendaQuery.js';

const TOKEN = 'token-admin-de-teste';

const config: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'gemini-chave-secreta-9z9z',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  adminToken: TOKEN,
  wsPort: 0,
  logLevel: 'silent',
  geminiLiveModel: 'test-model',
  openaiRealtimeModel: 'test-model',
  haUrl: '',
  haToken: '',
  devicesConfigPath: 'config/devices.json',
  deviceRegistryTtlMs: 300_000,
  providerConnectTimeoutMs: 5000,
  geminiVadSilenceMs: null,
  geminiVadEndSensitivity: null,
  geminiManualActivity: false,
  geminiThinkingBudget: 0,
  geminiDebugMessages: false,
  userSilenceCutoffMs: 500,
  audioPacingLeadMs: 250,
  openaiVadType: 'server_vad',
  openaiVadSilenceMs: null,
  openaiDebugMessages: false,
  openaiVoice: 'marin',
  dbPath: ':memory:',
  missedGraceMs: 15 * 60_000,
  alarmMaxRingMs: 5 * 60_000,
  reminderMaxConcurrent: 20,
  reminderMaxPerRoom: 20,
  reminderFallbackRoomId: '',
  ringListenWindowMs: 6_000,
  ringBargeInGuardMs: 2_000,
  ringSilentRetryMs: 60_000,
  ringMaxDeferMs: 3_000,
  reminderSnoozeMaxMinutes: 60,
  weatherLatitude: null,
  weatherLongitude: null,
  weatherTtlMs: 600_000,
  weatherMaxStaleMs: 10_800_000,
};

interface Harness {
  baseUrl: string;
  settings: RuntimeSettings;
  reminderStore: ReminderStore;
  registry: DeviceRegistrySource;
  diagnostics: Diagnostics;
  cancelled: number[];
  saved: Array<{ id: number; labelChanged: boolean }>;
  fetchCalls: string[];
  restarts: number;
  /** Releases que o "GitHub" falso do harness publica — os casos de OTA mexem aqui. */
  firmware: FakeFirmwareRelease[];
  /** Compasso falso do "O que a Luna vê hoje": os casos trocam a resposta. */
  calendar: { configured: boolean; response: CompassoResult<CompassoList>; calls: unknown[] };
  stop(): Promise<void>;
}

interface FakeFirmwareRelease {
  version: string;
  build: string;
  bin: Buffer;
  /** Força o manifest a anunciar outro SHA-256 (download corrompido). */
  manifestSha256?: string;
}

const FW_REPO = 'teste/luna';

/** `fetch` do `FirmwareReleases` contra um GitHub falso: API de releases, manifest e .bin. */
function fakeGithub(releases: () => FakeFirmwareRelease[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url === `https://api.github.com/repos/${FW_REPO}/releases?per_page=50`) {
      return new Response(
        JSON.stringify(
          releases().map((r) => ({
            tag_name: `fw-v${r.version}`,
            draft: false,
            prerelease: false,
            published_at: '2026-11-17T12:00:00Z',
            html_url: `https://github.com/${FW_REPO}/releases/tag/fw-v${r.version}`,
            assets: [
              { name: 'firmware.bin', browser_download_url: `https://dl.test/${r.version}/firmware.bin` },
              { name: 'manifest.json', browser_download_url: `https://dl.test/${r.version}/manifest.json` },
            ],
          })),
        ),
      );
    }
    const m = /^https:\/\/dl\.test\/([^/]+)\/(firmware\.bin|manifest\.json)$/.exec(url);
    const rel = m ? releases().find((r) => r.version === m[1]) : undefined;
    if (!m || !rel) return new Response('nada', { status: 404 });
    if (m[2] === 'firmware.bin') return new Response(rel.bin);
    return new Response(
      JSON.stringify({
        version: rel.version,
        build: rel.build,
        size: rel.bin.length,
        sha256: rel.manifestSha256 ?? createHash('sha256').update(rel.bin).digest('hex'),
        date: '2026-11-17T12:00:00Z',
        changelog: `mudanças da ${rel.version}`,
      }),
    );
  }) as unknown as typeof fetch;
}

/** Servidor HTTP de verdade, porta efêmera, com a API admin ligada como em `index.ts`. */
async function startHarness(cfg: AppConfig): Promise<Harness> {
  const ringBuffer = new ConversationRingBuffer();
  const roomManager = new RoomManager(cfg, ringBuffer);
  const reminderStore = ReminderStore.open(':memory:');
  const settings = RuntimeSettings.open(
    cfg,
    new SettingsStore(reminderStore.sharedDatabase()),
    () => ({
      aliases: { luz: 'luz_bancada' },
      exclude: [],
      devices: [
        { device: 'luz_bancada', roomId: 'escritorio', entityId: 'switch.luz_bancada', domain: 'switch' },
      ],
    }),
    {},
  );
  const haClient = new HomeAssistantClient(settings.current());
  // Mesma fonte do `index.ts`: os overrides vêm do banco, não do arquivo.
  const registry = new DeviceRegistrySource(haClient, settings.get('devices'));
  settings.onChange('rooms', (rooms) => registry.setRoomAreas(rooms.areas));
  settings.onChange('devices', (overrides) => registry.setOverrides(overrides));

  const server = new WsServer(cfg, roomManager, haClient, registry, reminderStore, null);
  // Sem `start()`: o LOG_LEVEL dos testes é `silent`, então o tap não vê
  // nada — os casos alimentam o diagnóstico com `ingest` direto.
  const diagnostics = new Diagnostics(new DiagnosticsStore(reminderStore.sharedDatabase()));
  const harness: Harness = {
    baseUrl: '',
    settings,
    reminderStore,
    registry,
    diagnostics,
    cancelled: [],
    saved: [],
    fetchCalls: [],
    restarts: 0,
    firmware: [],
    calendar: {
      configured: true,
      response: { ok: true, status: 200, data: { timezone: 'America/Sao_Paulo', items: [], next_cursor: null } },
      calls: [],
    },
    async stop() {
      otaManager.stop();
      await server.stop();
      reminderStore.close();
      await roomManager.destroy();
      ringBuffer.destroy();
    },
  };
  // OTA como em `index.ts`, com o GitHub falso e prazos curtos para os casos
  // de timeout não esperarem minutos.
  const firmwareReleases = new FirmwareReleases({ repo: FW_REPO, ttlMs: 0, fetchImpl: fakeGithub(() => harness.firmware) });
  const otaManager = new OtaManager({
    releases: firmwareReleases,
    link: {
      connection: (deviceId) => server.otaConnection(deviceId),
      sendOtaStart: (deviceId, payload) => server.sendOtaStart(deviceId, payload),
    },
    timeouts: { firstResponseMs: 400, progressStallMs: 1_000, rebootMs: 2_000 },
  });
  server.setOtaEvents(otaManager);
  server.addHttpRoute(otaManager.serve);
  server.setAdminHandler(
    new AdminApi({
      config: cfg,
      settings,
      satellites: () => server.listSatellites(),
      deviceRegistry: registry,
      haClient,
      roomManager,
      reminderStore,
      cancelReminder: (r) => {
        reminderStore.markStatus(r.id, 'cancelled');
        harness.cancelled.push(r.id);
      },
      onReminderSaved: (r, labelChanged) => {
        harness.saved.push({ id: r.id, labelChanged });
      },
      weatherSource: null,
      diagnostics,
      calendarClient: {
        get configured() {
          return harness.calendar.configured;
        },
        agenda: async (params: unknown) => {
          harness.calendar.calls.push(params);
          return harness.calendar.response;
        },
        pendingTasks: async () => harness.calendar.response,
      } as never,
      // Só o que o painel chama por fora: geocoding e previsão do Open-Meteo,
      // e o health do Compasso (200 só com o token certo).
      fetchImpl: (async (url: string, init?: RequestInit) => {
        harness.fetchCalls.push(String(url));
        if (String(url).endsWith('/api/v1/health')) {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          return auth === 'Bearer token-do-compasso'
            ? new Response(JSON.stringify({ ok: true, version: 'abc123' }))
            : new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Token inválido.' } }), { status: 401 });
        }
        if (String(url).includes('geocoding-api')) {
          return new Response(JSON.stringify({ results: [{ name: 'Santos', admin1: 'São Paulo', country: 'Brasil', latitude: -23.96, longitude: -46.33 }] }));
        }
        return new Response(JSON.stringify({
          current: { temperature_2m: 24, apparent_temperature: 25, relative_humidity_2m: 60, wind_speed_10m: 5, weather_code: 1 },
          daily: { time: ['2026-09-25'], weather_code: [1], temperature_2m_max: [28], temperature_2m_min: [18], precipitation_probability_max: [10] },
        }));
      }) as unknown as typeof fetch,
      disconnectSatellite: (deviceId) => server.disconnectDevice(deviceId, 'desconectado pelo painel'),
      setSatelliteConfig: (deviceId, patch) => server.setSatelliteConfig(deviceId, patch, 300),
      ota: { releases: firmwareReleases, manager: otaManager },
      onRestart: () => {
        harness.restarts += 1;
      },
    }).handle,
  );
  server.setBlockedSource((deviceId) => settings.get('satellites').blocked.includes(deviceId));
  server.start();
  while (server.port === null) await new Promise((r) => setTimeout(r, 10));
  harness.baseUrl = `http://127.0.0.1:${server.port}`;
  return harness;
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('API admin', () => {
  let h: Harness;

  before(async () => {
    createLogger(config);
    h = await startHarness(config);
  });

  after(async () => h.stop());

  it('sem token no header responde 401', async () => {
    assert.equal((await call(h, 'GET', '/admin/v1/status', undefined, null)).status, 401);
    assert.equal((await call(h, 'GET', '/admin/v1/status', undefined, 'errado')).status, 401);
  });

  it('status traz versão, semáforos e contagem de satélites', async () => {
    const res = await call(h, 'GET', '/admin/v1/status');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.version, 'string');
    assert.equal(res.body.satellites_online, 0);
    assert.equal(res.body.connections.ha.light, 'off', 'HA sem URL = desligado');
    assert.equal(res.body.connections.weather.light, 'off');
  });

  it('o /health continua respondendo sem token, agora com versão', async () => {
    const res = await fetch(`${h.baseUrl}/health`);
    const body = (await res.json()) as { version?: string };
    assert.equal(res.status, 200);
    assert.equal(typeof body.version, 'string');
  });

  it('nunca devolve segredo na leitura de configuração', async () => {
    const res = await call(h, 'GET', '/admin/v1/settings/provider');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.value.geminiApiKey, { set: true, last4: '9z9z' });
    assert.ok(!JSON.stringify(res.body).includes('gemini-chave-secreta'));
    assert.equal(res.body.applies, 'next_session');
  });

  it('escrita inválida devolve 422 com o campo', async () => {
    const res = await call(h, 'PUT', '/admin/v1/settings/ha', { url: 'nao-e-url' });
    assert.equal(res.status, 422);
    assert.equal(res.body.field, 'url');
  });

  it('escrita válida grava e devolve mascarado', async () => {
    const res = await call(h, 'PUT', '/admin/v1/settings/ha', {
      url: 'http://192.168.0.10:8123',
      token: 'um-token-longo-do-ha-abcd',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.value.url, 'http://192.168.0.10:8123');
    assert.deepEqual(res.body.value.token, { set: true, last4: 'abcd' });
    assert.equal(h.settings.current().haToken, 'um-token-longo-do-ha-abcd');
  });

  it('testar conexão com URL de outra origem não leva o token gravado', async () => {
    // Estado do teste anterior: HA gravado em http://192.168.0.10:8123 com token.
    const res = await call(h, 'POST', '/admin/v1/settings/ha/test', { url: 'http://192.168.0.99:9999' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /digite o token/);
  });

  it('trocar a URL do HA sem o token é 422 no campo token', async () => {
    const res = await call(h, 'PUT', '/admin/v1/settings/ha', { url: 'https://host-qualquer.example' });
    assert.equal(res.status, 422);
    assert.equal(res.body.field, 'token');
    assert.equal(h.settings.current().haUrl, 'http://192.168.0.10:8123');
  });

  it('testar a agenda sem nada configurado pede URL e token', async () => {
    const res = await call(h, 'POST', '/admin/v1/settings/calendar/test', {});
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /obrigatórios/);
  });

  it('testar a agenda chama o /health do Compasso com o token', async () => {
    const good = await call(h, 'POST', '/admin/v1/settings/calendar/test', {
      url: 'http://127.0.0.1:8090/api/v1',
      token: 'token-do-compasso',
    });
    assert.equal(good.body.ok, true);
    assert.equal(good.body.version, 'abc123');

    const bad = await call(h, 'POST', '/admin/v1/settings/calendar/test', {
      url: 'http://127.0.0.1:8090/api/v1',
      token: 'errado',
    });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error, 'credencial recusada');
  });

  it('voz avançada vale na próxima sessão; clima na hora', async () => {
    const voice = await call(h, 'GET', '/admin/v1/settings/voice');
    assert.equal(voice.status, 200);
    assert.equal(voice.body.applies, 'next_session');
    const saved = await call(h, 'PUT', '/admin/v1/settings/voice', { geminiVadSilenceMs: 400 });
    assert.equal(saved.body.value.geminiVadSilenceMs, 400);
    assert.equal(h.settings.current().geminiVadSilenceMs, 400);

    const weather = await call(h, 'PUT', '/admin/v1/settings/weather', { city: 'Santos', latitude: -23.96, longitude: -46.33 });
    assert.equal(weather.status, 200);
    assert.equal(weather.body.applies, 'immediate');
    assert.equal(h.settings.current().weatherLongitude, -46.33);
  });

  it('geocode e teste do clima usam o fetch injetado, sem gravar', async () => {
    h.fetchCalls.length = 0;
    const geo = await call(h, 'POST', '/admin/v1/settings/weather/geocode', { city: 'Santos' });
    assert.equal(geo.status, 200);
    assert.equal(geo.body.results[0].label, 'Santos, São Paulo, Brasil');
    assert.match(h.fetchCalls[0]!, /geocoding-api\.open-meteo\.com.*name=Santos/);

    const test = await call(h, 'POST', '/admin/v1/settings/weather/test', { latitude: -10, longitude: -50 });
    assert.equal(test.body.ok, true);
    assert.equal(test.body.now.temperature_c, 24);
    assert.match(h.fetchCalls[1]!, /latitude=-10/);
    assert.equal(h.settings.get('weather').latitude, -23.96, 'testar não grava');
    assert.equal((await call(h, 'POST', '/admin/v1/settings/weather/geocode', { city: 'x' })).status, 422);
  });

  it('caminho com escape malformado é 400, não 500', async () => {
    assert.equal((await call(h, 'PUT', '/admin/v1/satellites/%E0', { name: 'x' })).status, 400);
  });

  it('grupos fora da lista editável não existem na rota genérica', async () => {
    assert.equal((await call(h, 'GET', '/admin/v1/settings/rooms')).status, 404);
  });

  it('mapear sala ↔ área faz a sala enxergar os dispositivos da área na hora', async () => {
    let rooms = await call(h, 'GET', '/admin/v1/rooms');
    const antes = rooms.body.rooms.find((r: { room_id: string }) => r.room_id === 'escritorio');
    assert.equal(antes.devices.length, 1);

    const res = await call(h, 'PUT', '/admin/v1/rooms/desktop_diogo', { area: 'escritorio' });
    assert.equal(res.status, 200);
    assert.equal(h.registry.current().resolve('luz_bancada', 'desktop_diogo').ok, true);

    rooms = await call(h, 'GET', '/admin/v1/rooms');
    const desktop = rooms.body.rooms.find((r: { room_id: string }) => r.room_id === 'desktop_diogo');
    assert.equal(desktop.area, 'escritorio');
    assert.equal(desktop.devices.length, 1);

    await call(h, 'PUT', '/admin/v1/rooms/desktop_diogo', { area: null });
    assert.equal(h.registry.current().resolve('luz_bancada', 'desktop_diogo').ok, false);
  });

  it('editar apelidos vale na hora', async () => {
    const res = await call(h, 'PUT', '/admin/v1/devices', { aliases: { bancada: 'luz_bancada' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.aliases, { bancada: 'luz_bancada' });
    assert.equal(h.registry.current().resolve('bancada', 'escritorio').ok, true);
  });

  it('exclusões e dispositivos manuais pelo painel valem na hora', async () => {
    let res = await call(h, 'PUT', '/admin/v1/devices', { exclude: ['switch.luz_bancada'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.exclude, ['switch.luz_bancada']);
    assert.equal(h.registry.current().resolve('luz_bancada', 'escritorio').ok, false, 'excluída');
    assert.deepEqual(res.body.aliases, { bancada: 'luz_bancada' }, 'campo ausente mantém');

    res = await call(h, 'PUT', '/admin/v1/devices', {
      exclude: [],
      devices: [{ device: 'abajur', room_id: 'quarto', entity_id: 'light.abajur' }],
    });
    assert.equal(res.status, 200);
    assert.equal(h.registry.current().resolve('abajur', 'quarto').ok, true);

    res = await call(h, 'PUT', '/admin/v1/devices', { devices: [{ device: 'x', room_id: 'quarto', entity_id: 'sem-ponto' }] });
    assert.equal(res.status, 422);
    assert.equal((await call(h, 'PUT', '/admin/v1/devices', {})).status, 422);
  });

  it('manual novo fora de switch/light/fan é recusado; o que já estava fica', async () => {
    const res = await call(h, 'PUT', '/admin/v1/devices', {
      devices: [
        { device: 'abajur', room_id: 'quarto', entity_id: 'light.abajur' },
        { device: 'portao', room_id: 'garagem', entity_id: 'script.abrir_portao' },
      ],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.field, 'devices');
    assert.equal(h.registry.current().resolve('portao', 'garagem').ok, false);
  });

  it('testar: só entidade conhecida e domínio acionável', async () => {
    assert.equal((await call(h, 'POST', '/admin/v1/devices/test', { entity_id: 'lock.porta', action: 'off' })).status, 404);
    assert.equal((await call(h, 'POST', '/admin/v1/devices/test', { entity_id: 'light.abajur', action: 'abrir' })).status, 422);
    // HA sem URL neste harness: a chamada vai, e a falha volta como resultado, não como 500.
    const res = await call(h, 'POST', '/admin/v1/devices/test', { entity_id: 'light.abajur', action: 'on' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
  });

  it('forçar refresh responde com o estado da descoberta', async () => {
    const res = await call(h, 'POST', '/admin/v1/devices/refresh');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.count, 'number');
  });

  it('nome de satélite aparece na lista mesmo offline', async () => {
    await call(h, 'PUT', '/admin/v1/satellites/esp32-aa', { name: 'Quarto' });
    const res = await call(h, 'GET', '/admin/v1/satellites');
    const sat = res.body.satellites.find((s: { device_id: string }) => s.device_id === 'esp32-aa');
    assert.equal(sat.name, 'Quarto');
    assert.equal(sat.online, false);
    // Nunca conectou: sem device_info nem endereço — o painel mostra "desconhecida".
    assert.equal(sat.device_info, null);
    assert.equal(sat.remote_address, null);
  });

  it('lista e cancela lembretes', async () => {
    const r = h.reminderStore.insertOnce({ roomId: 'quarto', label: 'remédio', dueAtUtc: Date.now() + 3_600_000 });
    let res = await call(h, 'GET', '/admin/v1/reminders');
    assert.equal(res.body.reminders.length, 1);
    assert.equal(res.body.reminders[0].label, 'remédio');

    res = await call(h, 'DELETE', `/admin/v1/reminders/${r.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(h.cancelled, [r.id]);

    res = await call(h, 'DELETE', `/admin/v1/reminders/${r.id}`);
    assert.equal(res.status, 404, 'cancelar de novo não finge sucesso');
  });

  it('cria lembrete pelo painel com hora de parede de São Paulo', async () => {
    const amanha = new Date(Date.now() + 86_400_000 - 3 * 3_600_000);
    const date = amanha.toISOString().slice(0, 10);
    const res = await call(h, 'POST', '/admin/v1/reminders', { room_id: 'quarto', label: 'remédio', repeat: 'none', date, time: '07:30' });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'once');
    // 07:30 em São Paulo = 10:30 UTC.
    assert.equal(new Date(res.body.next_due_utc).toISOString().slice(11, 16), '10:30');
    assert.equal(res.body.has_audio, false);
    assert.deepEqual(h.saved.at(-1), { id: res.body.id, labelChanged: true });
  });

  it('criação recusa o nome da Luna, horário passado e data inexistente', async () => {
    const base = { room_id: 'quarto', repeat: 'none', time: '07:30' };
    let res = await call(h, 'POST', '/admin/v1/reminders', { ...base, label: 'falar com a Luna', date: '2099-01-01' });
    assert.equal(res.status, 422);
    assert.equal(res.body.field, 'label');
    res = await call(h, 'POST', '/admin/v1/reminders', { ...base, date: '2020-01-01' });
    assert.equal(res.body.field, 'date');
    res = await call(h, 'POST', '/admin/v1/reminders', { ...base, date: '2026-02-31' });
    assert.equal(res.body.field, 'date');
    res = await call(h, 'POST', '/admin/v1/reminders', { ...base, repeat: 'toda_hora' });
    assert.equal(res.body.field, 'repeat');
  });

  it('recorrente: próxima ocorrência calculada no servidor', async () => {
    const res = await call(h, 'POST', '/admin/v1/reminders', { room_id: 'sala', label: null, repeat: 'weekdays', time: '06:30' });
    assert.equal(res.status, 201);
    assert.equal(res.body.repeat_rule, 'weekdays');
    assert.equal(res.body.local_hour, 6);
    assert.equal(res.body.has_audio, null, 'alarme sem rótulo não tem fala');
    assert.ok(res.body.next_due_utc > Date.now());
  });

  it('editar troca horário e rótulo; rótulo novo apaga a fala gravada', async () => {
    const created = await call(h, 'POST', '/admin/v1/reminders', { room_id: 'quarto', label: 'água', repeat: 'daily', time: '09:00' });
    h.reminderStore.putAudio(created.body.id, Buffer.alloc(32));
    let res = await call(h, 'PUT', `/admin/v1/reminders/${created.body.id}`, { room_id: 'quarto', label: 'água', repeat: 'daily', time: '10:00' });
    assert.equal(res.status, 200);
    assert.equal(res.body.local_hour, 10);
    assert.equal(res.body.has_audio, true, 'só o horário mudou: fala continua valendo');

    res = await call(h, 'PUT', `/admin/v1/reminders/${created.body.id}`, { room_id: 'escritorio', label: 'beber água', repeat: 'daily', time: '10:00' });
    assert.equal(res.body.room_id, 'escritorio');
    assert.equal(res.body.has_audio, false);
    assert.deepEqual(h.saved.at(-1), { id: created.body.id, labelChanged: true });
  });

  it('editar só o rótulo com keep_schedule não mexe no horário (nem nos segundos)', async () => {
    const due = Date.now() + 95_000;
    const r = h.reminderStore.insertOnce({ roomId: 'quarto', label: 'forno', dueAtUtc: due });
    const res = await call(h, 'PUT', `/admin/v1/reminders/${r.id}`, { room_id: 'quarto', label: 'tirar do forno', keep_schedule: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.next_due_utc, due);
    assert.equal(res.body.label, 'tirar do forno');
    assert.match(res.body.local_time, /^\d{2}:\d{2}$/);
    assert.equal((await call(h, 'PUT', `/admin/v1/reminders/${r.id}`, { room_id: 'quarto', label: 'Luna', keep_schedule: true })).body.field, 'label');
  });

  it('não edita o que está tocando nem o que já acabou', async () => {
    const r = h.reminderStore.insertOnce({ roomId: 'quarto', label: null, dueAtUtc: Date.now() + 3_600_000 });
    const body = { room_id: 'quarto', repeat: 'daily', time: '08:00' };
    h.reminderStore.markRinging(r.id, r.nextDueUtc);
    assert.equal((await call(h, 'PUT', `/admin/v1/reminders/${r.id}`, body)).status, 409);
    h.reminderStore.markStatus(r.id, 'done');
    assert.equal((await call(h, 'PUT', `/admin/v1/reminders/${r.id}`, body)).status, 404);
  });

  it('histórico: eventos do log viram linha, com rótulo atual', async () => {
    const r = h.reminderStore.insertOnce({ roomId: 'quarto', label: 'pão', dueAtUtc: Date.now() + 3_600_000 });
    h.diagnostics.ingest(record({ event: 'reminder_fired', roomId: 'quarto', fields: { reminder_id: r.id } }));
    h.diagnostics.ingest(record({ event: 'alarm_snoozed', roomId: 'quarto', fields: { reminder_id: r.id, minutes: 5 } }));
    h.diagnostics.ingest(record({ event: 'alarm_missed', roomId: 'quarto', fields: {} }));
    const res = await call(h, 'GET', '/admin/v1/reminders/history?limit=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.events.map((e: { kind: string }) => e.kind), ['snoozed', 'fired']);
    assert.equal(res.body.complete, false, 'LOG_LEVEL silent: histórico não cresce e o painel precisa saber');
    assert.equal(res.body.events[0].label, 'pão');
  });

  describe('agenda: o que a Luna vê hoje', () => {
    const at = (hour: number): string => {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      return `${day}T${String(hour).padStart(2, '0')}:00:00-03:00`;
    };
    const item = (i: number, type: 'event' | 'class' | 'task'): CompassoItem => {
      const base = { id: `x${i}`, title: `Item ${i}`, start: at(7 + (i % 14)), end: null, all_day: false, location: null, recurring: false, occurrence_date: null };
      if (type === 'task') return { ...base, type, due: base.start, done: i % 2 === 0 };
      if (type === 'class') return { ...base, type, subject: null, professor: 'Prof. X', cancelled: true, location: 'B-204' };
      return { ...base, type };
    };
    const respond = (items: CompassoItem[]): void => {
      h.calendar.configured = true;
      h.calendar.response = { ok: true, status: 200, data: { timezone: 'America/Sao_Paulo', items, next_cursor: null } };
    };

    it('itens estruturados e o payload exato da tool, pelo mesmo caminho', async () => {
      respond([item(1, 'event'), item(2, 'class'), item(3, 'task')]);
      h.calendar.calls.length = 0;
      const res = await call(h, 'GET', '/admin/v1/calendar/today');
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'ok');
      assert.equal(res.body.max_spoken_items, MAX_SPOKEN_ITEMS);
      assert.equal(res.body.total, 3);
      assert.match(res.body.period, /^hoje/);
      assert.deepEqual(res.body.items.map((i: { type: string }) => i.type), ['event', 'class', 'task']);
      assert.equal(res.body.items[1].cancelled, true);
      assert.equal(res.body.items[1].location, 'B-204');
      assert.equal(res.body.items[2].done, false);
      assert.ok(res.body.items.every((i: { seen_by_luna: boolean }) => i.seen_by_luna));
      // O que o modelo recebe: mesma frase de horário que a tela mostra.
      assert.equal(res.body.tool_payload.success, true);
      assert.equal(res.body.tool_payload.items.length, 3);
      assert.equal(res.body.tool_payload.items[0].time, res.body.items[0].time);
      assert.equal(res.body.tool_payload.more, undefined);
      const params = h.calendar.calls[0] as { from: string; to: string };
      assert.ok(params.from.endsWith('T00:00:00-03:00'), 'intervalo de hoje resolvido como na tool');
    });

    it('acima do teto: só os primeiros N são vistos pela Luna e o resto vira more', async () => {
      respond(Array.from({ length: MAX_SPOKEN_ITEMS + 3 }, (_, i) => item(i, 'task')));
      const res = await call(h, 'GET', '/admin/v1/calendar/today');
      assert.equal(res.body.total, MAX_SPOKEN_ITEMS + 3);
      assert.equal(res.body.spoken_count, MAX_SPOKEN_ITEMS);
      assert.equal(res.body.more, true);
      assert.equal(res.body.tool_payload.more, true);
      assert.equal(res.body.items.filter((i: { seen_by_luna: boolean }) => !i.seen_by_luna).length, 3);
    });

    it('desligada: estado explícito, sem 500 e sem rede', async () => {
      h.calendar.configured = false;
      h.calendar.calls.length = 0;
      const res = await call(h, 'GET', '/admin/v1/calendar/today');
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'off');
      assert.equal(h.calendar.calls.length, 0);
      assert.deepEqual(res.body.tool_payload, { success: false, error: 'a agenda não está configurada' });
      h.calendar.configured = true;
    });

    it('credencial errada ou Compasso fora: estado de erro com o código', async () => {
      h.calendar.response = { ok: false, status: 401, code: 'unauthorized', message: 'a integração com o Compasso precisa de um token novo', field: null };
      const res = await call(h, 'GET', '/admin/v1/calendar/today');
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'error');
      assert.equal(res.body.error.code, 'unauthorized');
      assert.deepEqual(res.body.items, []);
    });
  });

  it('histórico da agenda: mais recente primeiro, params só com o que veio, limit', async () => {
    const store = h.diagnostics.store;
    const base = { roomId: 'quarto', dayOfMonth: null, kind: null, effort: null, attribute: null, hasSearch: false, itemCount: null, itemId: null, latencyMs: 80 };
    store.insertAgendaEvent({ ...base, at: Date.now() - 2000, tool: 'get_agenda', action: 'query', when: 'tomorrow', kind: 'all', result: 'ok', itemCount: 4 });
    store.insertAgendaEvent({ ...base, at: Date.now() - 1000, tool: 'manage_agenda', action: 'create_task', when: null, effort: 3, attribute: 'casa', result: 'ok', itemId: 'tsk_1' });
    store.insertAgendaEvent({ ...base, at: Date.now(), tool: 'get_agenda', action: 'query', when: null, result: 'unreachable', latencyMs: 2003 });

    const res = await call(h, 'GET', '/admin/v1/calendar/log?limit=2');
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 2);
    const [last, created] = res.body.events;
    assert.equal(last.result, 'unreachable');
    assert.equal(last.ok, false);
    assert.deepEqual(last.params, {});
    assert.equal(created.action, 'create_task');
    assert.deepEqual(created.params, { effort: 3, attribute: 'casa' });
    assert.equal(created.item_id, 'tsk_1');
    assert.equal(created.ok, true);
    assert.equal((await call(h, 'GET', '/admin/v1/calendar/log?limit=0')).status, 422);
    assert.equal((await call(h, 'GET', '/admin/v1/calendar/outra')).status, 404);
  });

  it('bootstrap é só leitura e sem segredo', async () => {
    const res = await call(h, 'GET', '/admin/v1/bootstrap');
    assert.equal(res.body.admin_token.set, true);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    assert.ok(!JSON.stringify(res.body).includes('test-secret'));
  });

  it('latência: série, meta e percentis por sala × provedor, sem sessão fria', async () => {
    const now = Date.now();
    for (const [i, ms] of [300, 500, 700, 900, 1200].entries()) {
      h.diagnostics.ingest(record({ event: 'ttfab', roomId: 'quarto', ts: now - 60_000 + i, fields: { latency_ms: ms, provider: 'gemini', device_id: 'esp32-aa', session_cold: false } }));
    }
    h.diagnostics.ingest(record({ event: 'ttfab', roomId: 'quarto', ts: now, fields: { latency_ms: 4000, provider: 'gemini', session_cold: true } }));
    // Amostra de três dias atrás fica fora da janela padrão de 24h.
    h.diagnostics.ingest(record({ event: 'ttfab', roomId: 'quarto', ts: now - 3 * 86_400_000, fields: { latency_ms: 50, provider: 'gemini' } }));

    const res = await call(h, 'GET', '/admin/v1/diagnostics/latency');
    assert.equal(res.status, 200);
    assert.equal(res.body.target_ms, 800);
    assert.equal(res.body.samples.length, 6);
    const [quarto] = res.body.summary;
    assert.equal(quarto.room_id, 'quarto');
    assert.equal(quarto.count, 5);
    assert.equal(quarto.cold, 1);
    assert.equal(quarto.p50_ms, 700);
    assert.equal(quarto.p90_ms, 1200);
    assert.equal(quarto.over_target, 2);

    const semana = await call(h, 'GET', '/admin/v1/diagnostics/latency?hours=168');
    assert.equal(semana.body.samples.length, 7);
    assert.equal((await call(h, 'GET', '/admin/v1/diagnostics/latency?hours=0')).status, 422);
  });

  it('erros: error sempre, warn só de dependência externa, mais recente primeiro', async () => {
    h.diagnostics.ingest(record({ level: 'warn', levelValue: 40, event: 'invalid_message', msg: 'ruído' }));
    h.diagnostics.ingest(record({ level: 'warn', levelValue: 40, event: 'ha_get_state', msg: 'HA não respondeu' }));
    h.diagnostics.ingest(record({ level: 'error', levelValue: 50, event: 'provider_connect_timeout', roomId: 'quarto', msg: 'provider caiu', fields: { timeout_ms: 5000 } }));

    const res = await call(h, 'GET', '/admin/v1/diagnostics/errors?limit=5');
    assert.equal(res.status, 200);
    const events = res.body.errors.map((e: { event: string }) => e.event);
    assert.deepEqual(events.slice(0, 2), ['provider_connect_timeout', 'ha_get_state']);
    assert.ok(!events.includes('invalid_message'));
    assert.deepEqual(res.body.errors[0].detail, { timeout_ms: 5000 });
  });

  it('log ao vivo em SSE: passado filtrado, depois linha nova', async () => {
    h.diagnostics.ingest(record({ event: 'room_created', roomId: 'sala', msg: 'sala antiga' }));
    h.diagnostics.ingest(record({ event: 'room_created', roomId: 'quarto', msg: 'quarto antigo' }));

    const controller = new AbortController();
    const res = await fetch(`${h.baseUrl}/admin/v1/logs/stream?room=quarto&level=info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream fechou antes de chegar ' + needle);
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(': ok');
    assert.ok(text.includes('quarto antigo'));
    assert.ok(!text.includes('sala antiga'), 'filtro de sala vale para o passado');

    h.diagnostics.ingest(record({ event: 'ttfab', roomId: 'quarto', msg: 'linha nova', fields: { latency_ms: 10, provider: 'gemini' } }));
    h.diagnostics.ingest(record({ level: 'debug', levelValue: 20, roomId: 'quarto', msg: 'debug escondido' }));
    await readUntil('linha nova');
    controller.abort();
    assert.ok(!text.includes('debug escondido'));
  });

  it('log ao vivo recusa nível desconhecido', async () => {
    assert.equal((await call(h, 'GET', '/admin/v1/logs/stream?level=barulho')).status, 422);
  });

  it('bloquear derruba a conexão aberta e recusa a reconexão no handshake', async () => {
    const deviceId = 'esp32-perdido';
    const open = await authenticate(h, deviceId);
    assert.equal(open.reply.type, 'auth_ok');

    const closed = new Promise<number>((r) => open.ws.once('close', (code) => r(code)));
    const res = await call(h, 'PUT', `/admin/v1/satellites/${deviceId}`, { blocked: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(await closed, 1000);

    const again = await authenticate(h, deviceId);
    assert.equal(again.reply.type, 'auth_error');
    assert.equal(again.reply.reason, 'satélite bloqueado');
    again.ws.terminate();

    const list = await call(h, 'GET', '/admin/v1/satellites');
    assert.equal(list.body.satellites.find((s: { device_id: string }) => s.device_id === deviceId).blocked, true);

    await call(h, 'PUT', `/admin/v1/satellites/${deviceId}`, { blocked: false });
    const back = await authenticate(h, deviceId);
    assert.equal(back.reply.type, 'auth_ok');
    back.ws.terminate();
  });

  it('desconectar fecha a conexão; satélite desconhecido fecha zero', async () => {
    const s = await authenticate(h, 'esp32-desconectar');
    const closed = new Promise<void>((r) => s.ws.once('close', () => r()));
    const res = await call(h, 'POST', '/admin/v1/satellites/esp32-desconectar/disconnect');
    assert.equal(res.body.closed, 1);
    await closed;
    assert.equal((await call(h, 'POST', '/admin/v1/satellites/ninguem/disconnect')).body.closed, 0);
  });

  describe('trocar a sala do satélite (set_config)', () => {
    /**
     * Satélite falso que responde `set_config` como o firmware: grava, manda
     * `config_ack` e reconecta autenticando na sala nova.
     */
    function answerLikeFirmware(h: Harness, deviceId: string, ws: WebSocket, reply: (msg: any) => any): void {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'set_config') return;
        const ack = reply(msg);
        ws.send(serializeControlMessage({ ...createEnvelope('config_ack', msg.room_id), request_id: msg.request_id, ...ack } as never));
        if (ack.reconnect) {
          ws.close();
          void authenticate(h, deviceId, msg.config.room_id).then((s) => reconnected.push(s.ws));
        }
      });
    }
    const reconnected: WebSocket[] = [];
    after(() => reconnected.forEach((ws) => ws.terminate()));

    it('aplica, o satélite reconecta e aparece na sala nova', async () => {
      const deviceId = 'esp32-muda-sala';
      const s = await authenticate(h, deviceId, 'sala_de_estar');
      let seen: any = null;
      answerLikeFirmware(h, deviceId, s.ws, (msg) => {
        seen = msg;
        return { ok: true, reconnect: true, results: { room_id: { ok: true } } };
      });

      const res = await call(h, 'PUT', `/admin/v1/satellites/${deviceId}/config`, { room_id: 'quarto' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { device_id: deviceId, room_id: 'quarto', previous_room_id: 'sala_de_estar', reconnect: true });
      assert.equal(seen.room_id, 'sala_de_estar', 'envelope vai na sala da conexão atual');
      assert.deepEqual(seen.config, { room_id: 'quarto' });
      assert.equal(typeof seen.request_id, 'string');

      let sat: any = null;
      for (let i = 0; i < 50 && sat?.room_id !== 'quarto'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        sat = (await call(h, 'GET', '/admin/v1/satellites')).body.satellites.find((x: any) => x.device_id === deviceId);
      }
      assert.equal(sat.room_id, 'quarto');
      assert.equal(sat.online, true);
    });

    it('satélite ocupado com um turno: 409 e nada muda', async () => {
      const s = await authenticate(h, 'esp32-ocupado', 'cozinha');
      answerLikeFirmware(h, 'esp32-ocupado', s.ws, () => ({
        ok: false,
        reconnect: false,
        reason: 'ocupado',
        results: { room_id: { ok: false, error: 'ocupado' } },
      }));
      const res = await call(h, 'PUT', '/admin/v1/satellites/esp32-ocupado/config', { room_id: 'quarto' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /ocupado/);
      s.ws.terminate();
    });

    it('firmware antigo, que ignora set_config: timeout vira 504 com a explicação', async () => {
      const s = await authenticate(h, 'esp32-antigo', 'cozinha');
      const res = await call(h, 'PUT', '/admin/v1/satellites/esp32-antigo/config', { room_id: 'quarto' });
      assert.equal(res.status, 504);
      assert.match(res.body.error, /firmware anterior/);
      // A conexão segue de pé: o servidor não derruba quem não entende o tipo.
      assert.equal(s.ws.readyState, WebSocket.OPEN);
      s.ws.terminate();
    });

    it('cliente que responde "não suportado" (desktop): 409', async () => {
      const s = await authenticate(h, 'desktop-uuid', 'escritorio');
      answerLikeFirmware(h, 'desktop-uuid', s.ws, () => ({
        ok: false,
        reconnect: false,
        results: { room_id: { ok: false, error: 'não suportado' } },
      }));
      const res = await call(h, 'PUT', '/admin/v1/satellites/desktop-uuid/config', { room_id: 'quarto' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /não suporta/);
      s.ws.terminate();
    });

    it('offline é 409; sala fora do formato é 422 sem falar com o satélite', async () => {
      const off = await call(h, 'PUT', '/admin/v1/satellites/ninguem/config', { room_id: 'quarto' });
      assert.equal(off.status, 409);
      assert.match(off.body.error, /offline/);

      const s = await authenticate(h, 'esp32-formato', 'cozinha');
      let asked = false;
      s.ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'set_config') asked = true;
      });
      for (const room_id of ['Sala De Estar', '', 'a'.repeat(65), 42]) {
        const res = await call(h, 'PUT', '/admin/v1/satellites/esp32-formato/config', { room_id });
        assert.equal(res.status, 422);
        assert.equal(res.body.field, 'room_id');
      }
      assert.equal((await call(h, 'PUT', '/admin/v1/satellites/esp32-formato/config', {})).status, 422);
      assert.equal(asked, false);
      s.ws.terminate();
    });

    it('conexão que cai antes do config_ack: 409 na hora, sem esperar o timeout', async () => {
      const s = await authenticate(h, 'esp32-cai', 'cozinha');
      s.ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'set_config') s.ws.terminate();
      });
      const res = await call(h, 'PUT', '/admin/v1/satellites/esp32-cai/config', { room_id: 'quarto' });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /caiu/);
    });

    it('config_ack de outro satélite não fecha o pedido alheio', async () => {
      const target = await authenticate(h, 'esp32-alvo', 'cozinha');
      const intruder = await authenticate(h, 'esp32-intruso', 'cozinha');
      target.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'set_config') return;
        intruder.ws.send(
          serializeControlMessage({
            ...createEnvelope('config_ack', 'cozinha'),
            request_id: msg.request_id,
            ok: true,
            reconnect: false,
            results: { room_id: { ok: true } },
          } as never),
        );
      });
      const res = await call(h, 'PUT', '/admin/v1/satellites/esp32-alvo/config', { room_id: 'quarto' });
      assert.equal(res.status, 504);
      target.ws.terminate();
      intruder.ws.terminate();
    });
  });

  it('backup não leva segredo nenhum, nem mascarado', async () => {
    const res = await call(h, 'GET', '/admin/v1/backup');
    assert.equal(res.status, 200);
    assert.equal(res.body.format, 'luna-backup');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('gemini-chave-secreta'));
    assert.ok(!text.includes('um-token-longo-do-ha'));
    assert.equal('geminiApiKey' in res.body.settings.provider, false);
    assert.equal('token' in res.body.settings.ha, false);
    assert.ok(Array.isArray(res.body.reminders));
  });

  it('restaurar: valida tudo antes, aplica como patch e mantém os segredos gravados', async () => {
    const backup = (await call(h, 'GET', '/admin/v1/backup')).body;
    const tokenAntes = h.settings.current().haToken;

    // Mexe depois do backup; a restauração tem de voltar.
    await call(h, 'PUT', '/admin/v1/devices', { aliases: { outro: 'luz_bancada' } });
    let res = await call(h, 'POST', '/admin/v1/restore', { backup });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(h.settings.get('devices').aliases, backup.settings.devices.aliases);
    assert.equal(h.settings.current().haToken, tokenAntes, 'segredo ausente do arquivo = mantém');

    // Um grupo inválido recusa tudo, sem meio aplicar.
    const bad = structuredClone(backup);
    bad.settings.devices.aliases = { mudou: 'luz_bancada' };
    bad.settings.weather = { latitude: 10, longitude: null };
    res = await call(h, 'POST', '/admin/v1/restore', { backup: bad });
    assert.equal(res.status, 422);
    assert.match(res.body.field, /^weather\./);
    assert.deepEqual(h.settings.get('devices').aliases, backup.settings.devices.aliases, 'nada foi gravado');

    assert.equal((await call(h, 'POST', '/admin/v1/restore', { backup: { format: 'outro' } })).status, 422);
  });

  it('restaurar com reminders=replace recria os lembretes e pula o que já passou', async () => {
    const backup = (await call(h, 'GET', '/admin/v1/backup')).body;
    backup.reminders = [
      { room_id: 'quarto', label: 'futuro', kind: 'once', due_at_utc: Date.now() + 7_200_000, local_hour: null, local_minute: null, repeat_rule: null },
      { room_id: 'quarto', label: 'passado', kind: 'once', due_at_utc: Date.now() - 60_000, local_hour: null, local_minute: null, repeat_rule: null },
      { room_id: 'sala', label: null, kind: 'recurring', due_at_utc: null, local_hour: 6, local_minute: 30, repeat_rule: 'weekdays' },
    ];
    const res = await call(h, 'POST', '/admin/v1/restore', { backup, reminders: 'replace' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reminders.created, 2);
    assert.equal(res.body.reminders.skipped, 1);
    const labels = h.reminderStore.listLive().map((r) => r.label).sort();
    assert.deepEqual(labels, [null, 'futuro'].sort());
  });

  it('backup e restauração deixam o bloqueio de fora; URL de outra origem é pulada, não recusa tudo', async () => {
    await call(h, 'PUT', '/admin/v1/satellites/esp32-sumido', { blocked: true });
    const backup = (await call(h, 'GET', '/admin/v1/backup')).body;
    assert.equal('blocked' in backup.settings.satellites, false);

    backup.settings.satellites.blocked = [];
    backup.settings.calendar = { url: 'https://agenda.outro-host.example' };
    const res = await call(h, 'POST', '/admin/v1/restore', { backup });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.not_applied, ['calendar.url']);
    assert.ok(h.settings.get('satellites').blocked.includes('esp32-sumido'), 'restaurar desbloqueou');
    await call(h, 'PUT', '/admin/v1/satellites/esp32-sumido', { blocked: false });
  });

  it('restaurar pula instante fora da janela e recusa horário não inteiro', async () => {
    const backup = (await call(h, 'GET', '/admin/v1/backup')).body;
    backup.reminders = [{ room_id: 'quarto', label: 'x', kind: 'once', due_at_utc: 1e15, local_hour: null, local_minute: null, repeat_rule: null }];
    let res = await call(h, 'POST', '/admin/v1/restore', { backup, reminders: 'replace' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reminders.skipped, 1);
    assert.equal((await call(h, 'GET', '/admin/v1/reminders')).status, 200);
    backup.reminders[0].due_at_utc = 1e300;
    res = await call(h, 'POST', '/admin/v1/restore', { backup, reminders: 'replace' });
    assert.equal(res.status, 422);
  });

  it('status e bootstrap trazem a release (null em dev)', async () => {
    assert.ok('release' in (await call(h, 'GET', '/admin/v1/status')).body);
    assert.ok('release' in (await call(h, 'GET', '/admin/v1/bootstrap')).body);
  });

  it('reiniciar responde 202 e só depois chama o shutdown', async () => {
    const res = await call(h, 'POST', '/admin/v1/restart');
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.restarts, 1);
  });
});

/** Abre um WebSocket de satélite de verdade contra o harness e manda `auth`. */
async function authenticate(h: Harness, deviceId: string, roomId = 'quarto'): Promise<{ ws: WebSocket; reply: any }> {
  const ws = new WebSocket(h.baseUrl.replace('http', 'ws'));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const reply = new Promise<any>((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
  ws.send(
    serializeControlMessage({
      ...createEnvelope('auth', roomId, {}),
      device_id: deviceId,
      token: computeAuthToken(config.wsAuthSecret, deviceId),
    } as never),
  );
  return { ws, reply: await reply };
}

let recordSeq = 1_000_000;
function record(partial: Partial<LogRecord>): LogRecord {
  return {
    seq: ++recordSeq,
    ts: Date.now(),
    level: 'info',
    levelValue: 30,
    event: null,
    roomId: null,
    msg: '',
    fields: {},
    ...partial,
  };
}

describe('API admin sem LUNA_ADMIN_TOKEN', () => {
  it('não existe: 404 em tudo, com ou sem token', async () => {
    const h = await startHarness({ ...config, adminToken: '' });
    try {
      assert.equal((await call(h, 'GET', '/admin/v1/status')).status, 404);
      assert.equal((await call(h, 'GET', '/admin/v1/status', undefined, '')).status, 404);
    } finally {
      await h.stop();
    }
  });
});

describe('isPrivateAddress', () => {
  it('aceita loopback e faixas privadas, inclusive IPv4 mapeado', () => {
    for (const addr of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.5', '::ffff:192.168.0.5']) {
      assert.equal(isPrivateAddress(addr), true, addr);
    }
  });

  it('recusa endereço público e o resto', () => {
    for (const addr of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', undefined]) {
      assert.equal(isPrivateAddress(addr), false, String(addr));
    }
  });
});

describe('adminTokenMatches', () => {
  it('exige Bearer e o token exato', () => {
    assert.equal(adminTokenMatches('abc', 'Bearer abc'), true);
    assert.equal(adminTokenMatches('abc', 'bearer abc'), true);
    assert.equal(adminTokenMatches('abc', 'abc'), false);
    assert.equal(adminTokenMatches('abc', 'Bearer abcd'), false);
    assert.equal(adminTokenMatches('', 'Bearer '), false);
  });
});

describe('OTA de firmware (rotas + satélite falso)', () => {
  let h: Harness;
  const open: WebSocket[] = [];
  const BIN_05 = Buffer.alloc(48 * 1024, 0xa5);
  const BIN_04 = Buffer.alloc(40 * 1024, 0x5a);

  before(async () => {
    createLogger(config);
    h = await startHarness(config);
    h.firmware.push(
      { version: '0.4.0', build: 'aaaaaaa', bin: BIN_04 },
      { version: '0.5.0', build: 'bbbbbbb', bin: BIN_05 },
    );
  });

  after(async () => {
    open.forEach((ws) => ws.terminate());
    await h.stop();
  });

  /** Satélite autenticado que já anunciou a versão (como o firmware faz após `auth_ok`). */
  async function satellite(deviceId: string, fwVersion: string, fwBuild: string): Promise<WebSocket> {
    const { ws } = await authenticate(h, deviceId, 'sala_de_estar');
    open.push(ws);
    ws.send(serializeControlMessage({ ...createEnvelope('device_info', 'sala_de_estar'), fw_version: fwVersion, fw_build: fwBuild } as never));
    for (let i = 0; i < 50; i++) {
      const sats = (await call(h, 'GET', '/admin/v1/satellites')).body.satellites as any[];
      if (sats.find((s) => s.device_id === deviceId && s.online)?.device_info?.fw_version === fwVersion) return ws;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('device_info não chegou');
  }

  function nextMessage(ws: WebSocket, type: string, ms = 2_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem ${type} em ${ms}ms`)), ms);
      const onMessage = (data: WebSocket.RawData): void => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== type) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      };
      ws.on('message', onMessage);
    });
  }

  async function waitState(deviceId: string, state: string, ms = 4_000): Promise<any> {
    const deadline = Date.now() + ms;
    let last: any = null;
    while (Date.now() < deadline) {
      last = (await call(h, 'GET', `/admin/v1/satellites/${deviceId}/ota`)).body.ota;
      if (last?.state === state) return last;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`OTA de ${deviceId} não chegou em ${state} (último: ${JSON.stringify(last)})`);
  }

  function send(ws: WebSocket, type: string, extra: Record<string, unknown>): void {
    ws.send(serializeControlMessage({ ...createEnvelope(type as never, 'sala_de_estar'), ...extra } as never));
  }

  it('lista as releases do GitHub da mais nova para a mais velha, com o manifest', async () => {
    const res = await call(h, 'GET', '/admin/v1/firmware/releases');
    assert.equal(res.status, 200);
    assert.equal(res.body.repo, FW_REPO);
    assert.equal(res.body.latest, '0.5.0');
    assert.deepEqual(res.body.releases.map((r: any) => r.version), ['0.5.0', '0.4.0']);
    const r = res.body.releases[0];
    assert.equal(r.tag, 'fw-v0.5.0');
    assert.equal(r.changelog, 'mudanças da 0.5.0');
    assert.equal(r.manifest.size, BIN_05.length);
    assert.equal(r.manifest.sha256, createHash('sha256').update(BIN_05).digest('hex'));
    assert.equal(r.manifest.build, 'bbbbbbb');
  });

  it('atualiza: ota_start, imagem de uso único na LAN, progresso, reinício e device_info na versão nova', async () => {
    const id = 'esp32-ota-ok';
    const ws = await satellite(id, '0.4.0', 'aaaaaaa');
    const started = nextMessage(ws, 'ota_start');

    const res = await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    assert.equal(res.status, 202);
    assert.equal(res.body.ota.state, 'downloading');
    assert.equal(res.body.ota.from_version, '0.4.0');
    assert.equal(res.body.ota.target_version, '0.5.0');

    const start = await started;
    assert.equal(start.room_id, 'sala_de_estar');
    assert.equal(start.version, '0.5.0');
    assert.equal(start.size, BIN_05.length);
    assert.equal(start.sha256, createHash('sha256').update(BIN_05).digest('hex'));
    assert.match(start.url, /^http:\/\/127\.0\.0\.1:\d+\/ota\/[0-9a-f]{32}\.bin$/);
    assert.equal((await waitState(id, 'sending')).percent, 0);

    // O satélite baixa do servidor, não do GitHub; a URL só vale uma vez.
    const image = await fetch(start.url);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), BIN_05);
    assert.equal((await fetch(start.url)).status, 404, 'uso único');

    send(ws, 'ota_progress', { percent: 0 });
    send(ws, 'ota_progress', { percent: 57 });
    for (let i = 0; i < 50 && (await call(h, 'GET', `/admin/v1/satellites/${id}/ota`)).body.ota.percent !== 57; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await call(h, 'GET', `/admin/v1/satellites/${id}/ota`)).body.ota.percent, 57);

    send(ws, 'ota_result', { ok: true });
    assert.equal((await waitState(id, 'rebooting')).percent, 100);
    // Uma OTA por vez: outro pedido no meio é recusado.
    assert.equal((await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.4.0' })).status, 409);

    // Reinício: conexão nova, `device_info` na versão do alvo.
    ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    const back = await satellite(id, '0.5.0', 'bbbbbbb');
    const done = await waitState(id, 'ok');
    assert.equal(done.error, null);
    assert.equal(typeof done.finished_at, 'number');
    const listed = (await call(h, 'GET', '/admin/v1/satellites')).body.satellites.find((s: any) => s.device_id === id);
    assert.equal(listed.ota.state, 'ok');
    back.terminate();
  });

  it('imagem que não se valida: o satélite volta na versão antiga e o estado é "revertido"', async () => {
    const id = 'esp32-ota-rollback';
    const ws = await satellite(id, '0.4.0', 'aaaaaaa');
    const started = nextMessage(ws, 'ota_start');
    assert.equal((await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' })).status, 202);
    await started;
    send(ws, 'ota_result', { ok: true });
    await waitState(id, 'rebooting');

    // O `device_info` repetido na MESMA conexão (troca de IP) não decide nada.
    send(ws, 'device_info', { fw_version: '0.4.0', fw_build: 'aaaaaaa' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call(h, 'GET', `/admin/v1/satellites/${id}/ota`)).body.ota.state, 'rebooting');

    ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    await satellite(id, '0.4.0', 'aaaaaaa');
    const done = await waitState(id, 'rolled_back');
    assert.match(done.error, /0\.4\.0/);
    assert.match(done.error, /revertida/);
  });

  it('download corrompido (sha256 diferente do manifest) é recusado antes de chegar ao satélite', async () => {
    h.firmware.push({ version: '0.6.0', build: 'ccccccc', bin: Buffer.alloc(1024, 1), manifestSha256: 'f'.repeat(64) });
    try {
      const id = 'esp32-ota-corrompido';
      const ws = await satellite(id, '0.5.0', 'bbbbbbb');
      let gotStart = false;
      ws.on('message', (d) => {
        if (JSON.parse(d.toString()).type === 'ota_start') gotStart = true;
      });
      assert.equal((await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.6.0' })).status, 202);
      const done = await waitState(id, 'failed');
      assert.match(done.error, /sha256 diferente/);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(gotStart, false);
    } finally {
      h.firmware.pop();
    }
  });

  it('satélite ocupado com uma conversa recusa: falha com motivo claro', async () => {
    const id = 'esp32-ota-ocupado';
    const ws = await satellite(id, '0.4.0', 'aaaaaaa');
    const started = nextMessage(ws, 'ota_start');
    await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    await started;
    send(ws, 'ota_result', { ok: false, error: 'ocupado' });
    assert.match((await waitState(id, 'failed')).error, /ocupado com uma conversa/);
    // Terminada a anterior, pode tentar de novo.
    assert.equal((await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' })).status, 202);
  });

  it('firmware anterior à OTA, que ignora ota_start: falha no timeout explicando', async () => {
    const id = 'esp32-ota-antigo';
    await satellite(id, '0.3.0', 'ddddddd');
    await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    assert.match((await waitState(id, 'failed', 3_000)).error, /firmware anterior à OTA/);
  });

  it('desktop/bancada respondem "não suportado"', async () => {
    const id = 'desktop-ota';
    const ws = await satellite(id, '0.1.0', 'eeeeeee');
    const started = nextMessage(ws, 'ota_start');
    await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    await started;
    send(ws, 'ota_result', { ok: false, error: 'não suportado' });
    assert.match((await waitState(id, 'failed')).error, /não suporta atualização/);
  });

  it('queda do WebSocket no meio do envio não encerra: sem progresso, falha no prazo', async () => {
    const id = 'esp32-ota-cai';
    const ws = await satellite(id, '0.4.0', 'aaaaaaa');
    const started = nextMessage(ws, 'ota_start');
    await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    await started;
    send(ws, 'ota_progress', { percent: 10 });
    await waitState(id, 'sending');
    ws.terminate();
    // Volta na versão antiga: o download pode estar andando na task do satélite.
    await new Promise((r) => setTimeout(r, 20));
    await satellite(id, '0.4.0', 'aaaaaaa');
    assert.equal((await call(h, 'GET', `/admin/v1/satellites/${id}/ota`)).body.ota.state, 'sending');
    assert.match((await waitState(id, 'failed', 3_000)).error, /sem progresso/);
  });

  it('ota_result perdido na queda: o satélite volta na versão nova e conta como ok', async () => {
    const id = 'esp32-ota-resultado-perdido';
    const ws = await satellite(id, '0.4.0', 'aaaaaaa');
    const started = nextMessage(ws, 'ota_start');
    await call(h, 'POST', `/admin/v1/satellites/${id}/ota`, { version: '0.5.0' });
    await started;
    await waitState(id, 'sending');
    ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    await satellite(id, '0.5.0', 'bbbbbbb');
    await waitState(id, 'ok');
  });

  it('erros do pedido: offline 409, versão inexistente 404, versão malformada 422', async () => {
    const off = await call(h, 'POST', '/admin/v1/satellites/ninguem/ota', { version: '0.5.0' });
    assert.equal(off.status, 409);
    assert.match(off.body.error, /offline/);

    await satellite('esp32-ota-erros', '0.4.0', 'aaaaaaa');
    const missing = await call(h, 'POST', '/admin/v1/satellites/esp32-ota-erros/ota', { version: '9.9.9' });
    assert.equal(missing.status, 404);
    for (const version of ['fw-v0.5.0', 'latest', '', 5]) {
      const bad = await call(h, 'POST', '/admin/v1/satellites/esp32-ota-erros/ota', { version });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.field, 'version');
    }
    assert.equal((await call(h, 'POST', '/admin/v1/satellites/esp32-ota-erros/ota', {})).status, 422);
    assert.equal((await call(h, 'GET', '/admin/v1/satellites/esp32-ota-erros/ota')).body.ota, null);
  });

  it('a imagem fica fora da API admin, mas URL inventada é 404', async () => {
    assert.equal((await fetch(`${h.baseUrl}/ota/${'0'.repeat(32)}.bin`)).status, 404);
    assert.equal((await fetch(`${h.baseUrl}/ota/${'0'.repeat(32)}.bin?x=1`, { method: 'POST' })).status, 404);
  });
});
