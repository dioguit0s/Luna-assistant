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
  stop(): Promise<void>;
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
    async stop() {
      await server.stop();
      reminderStore.close();
      await roomManager.destroy();
      ringBuffer.destroy();
    },
  };
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
      // Só o que o clima do painel chama: geocoding e previsão do Open-Meteo.
      fetchImpl: (async (url: string) => {
        harness.fetchCalls.push(String(url));
        if (String(url).includes('geocoding-api')) {
          return new Response(JSON.stringify({ results: [{ name: 'Santos', admin1: 'São Paulo', country: 'Brasil', latitude: -23.96, longitude: -46.33 }] }));
        }
        return new Response(JSON.stringify({
          current: { temperature_2m: 24, apparent_temperature: 25, relative_humidity_2m: 60, wind_speed_10m: 5, weather_code: 1 },
          daily: { time: ['2026-09-25'], weather_code: [1], temperature_2m_max: [28], temperature_2m_min: [18], precipitation_probability_max: [10] },
        }));
      }) as unknown as typeof fetch,
      onRestart: () => {
        harness.restarts += 1;
      },
    }).handle,
  );
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

  it('reiniciar responde 202 e só depois chama o shutdown', async () => {
    const res = await call(h, 'POST', '/admin/v1/restart');
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.restarts, 1);
  });
});

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
