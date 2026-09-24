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
  cancelled: number[];
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
  const harness: Harness = {
    baseUrl: '',
    settings,
    reminderStore,
    registry,
    cancelled: [],
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
      weatherSource: null,
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

  it('bootstrap é só leitura e sem segredo', async () => {
    const res = await call(h, 'GET', '/admin/v1/bootstrap');
    assert.equal(res.body.admin_token.set, true);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    assert.ok(!JSON.stringify(res.body).includes('test-secret'));
  });

  it('reiniciar responde 202 e só depois chama o shutdown', async () => {
    const res = await call(h, 'POST', '/admin/v1/restart');
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.restarts, 1);
  });
});

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
