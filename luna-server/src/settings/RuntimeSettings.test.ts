import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ReminderStore } from '../reminders/ReminderStore.js';
import { EMPTY_OVERRIDES, type DeviceOverrides } from '../ha/deviceRegistrySource.js';
import { SettingsStore } from './SettingsStore.js';
import { RuntimeSettings } from './RuntimeSettings.js';
import { SettingsValidationError, maskGroup, maskSecret } from './groups.js';

const base: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'gemini-key-do-env-1234',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0,
  logLevel: 'silent',
  geminiLiveModel: 'modelo-env',
  openaiRealtimeModel: 'gpt-realtime',
  haUrl: 'http://ha.local:8123/',
  haToken: 'token-do-env',
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

const DEVICES: DeviceOverrides = { aliases: { luz: 'luz_bancada' }, exclude: [], devices: [] };

describe('RuntimeSettings', () => {
  let reminderStore: ReminderStore;
  let store: SettingsStore;

  before(() => createLogger(base));

  beforeEach(() => {
    reminderStore = ReminderStore.open(':memory:');
    store = new SettingsStore(reminderStore.sharedDatabase());
  });

  afterEach(() => reminderStore.close());

  it('no primeiro boot semeia do .env e do devices.json', () => {
    const settings = RuntimeSettings.open(base, store, () => DEVICES, {});
    assert.equal(settings.get('ha').url, 'http://ha.local:8123', 'barra final normalizada');
    assert.equal(settings.get('ha').token, 'token-do-env');
    assert.deepEqual(settings.get('devices').aliases, { luz: 'luz_bancada' });
    assert.equal(settings.current().geminiLiveModel, 'modelo-env');
    assert.ok(store.get('ha') !== undefined, 'semente gravada no banco');
  });

  it('depois de semeado, o banco vence o .env', () => {
    RuntimeSettings.open(base, store, () => DEVICES, {}).update('ha', { token: 'token-do-painel' });

    const changedEnv = { ...base, haToken: 'outro-token-no-env' };
    const reopened = RuntimeSettings.open(changedEnv, store, () => DEVICES, { HA_TOKEN: 'outro-token-no-env' });
    assert.equal(reopened.get('ha').token, 'token-do-painel');
    assert.equal(reopened.current().haToken, 'token-do-painel');
  });

  it('o devices.json deixa de ser a fonte depois da semeadura', () => {
    RuntimeSettings.open(base, store, () => DEVICES, {}).update('devices', { aliases: { lampada: 'luz_sala' } });
    const reopened = RuntimeSettings.open(base, store, () => DEVICES, {});
    assert.deepEqual(reopened.get('devices').aliases, { lampada: 'luz_sala' });
  });

  it('patch inválido lança SettingsValidationError e não grava nada', () => {
    const settings = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    const before = store.get('ha');
    assert.throws(() => settings.update('ha', { url: 'ftp://ha' }), SettingsValidationError);
    assert.deepEqual(store.get('ha'), before);
  });

  it('recusa trocar para um provider sem chave', () => {
    const settings = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    assert.throws(
      () => settings.update('provider', { provider: 'openai' }),
      (err: unknown) => err instanceof SettingsValidationError && err.field === 'openaiApiKey',
    );
    assert.equal(settings.current().audioProvider, 'gemini');
  });

  it('semear de um .env sem a chave do provider falha no boot, como o loadConfig fazia', () => {
    assert.throws(() =>
      RuntimeSettings.open({ ...base, geminiApiKey: '' }, store, () => EMPTY_OVERRIDES, {}),
    );
  });

  it('semente inválida não é gravada: corrigir o .env destrava o boot seguinte', () => {
    assert.throws(() =>
      RuntimeSettings.open({ ...base, geminiApiKey: '' }, store, () => EMPTY_OVERRIDES, {}),
    );
    assert.equal(store.get('provider'), undefined, 'nada do provider gravado');
    assert.equal(store.get('ha'), undefined, 'nem dos outros grupos');

    const fixed = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    assert.equal(fixed.current().geminiApiKey, 'gemini-key-do-env-1234');
  });

  it('HA_URL sem esquema falha já no primeiro boot, não no segundo', () => {
    assert.throws(
      () => RuntimeSettings.open({ ...base, haUrl: '192.168.0.10:8123' }, store, () => EMPTY_OVERRIDES, {}),
      /"ha" inválida no \.env/,
    );
    assert.equal(store.get('ha'), undefined);
  });

  it('segredo vazio no banco é completado pelo .env', () => {
    RuntimeSettings.open({ ...base, haToken: '' }, store, () => EMPTY_OVERRIDES, {});
    const reopened = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, { HA_TOKEN: 'token-do-env' });
    assert.equal(reopened.get('ha').token, 'token-do-env');
    assert.deepEqual((store.get('ha') as { token: string }).token, 'token-do-env', 'e gravado');
  });

  it('notifica só os ouvintes do grupo alterado, com o valor novo e o anterior', () => {
    const settings = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    const calls: string[] = [];
    settings.onChange('ha', (next, prev) => calls.push(`ha:${prev.url}->${next.url}`));
    settings.onChange('rooms', () => calls.push('rooms'));

    settings.update('ha', { url: 'https://casa.local' });
    assert.deepEqual(calls, ['ha:http://ha.local:8123->https://casa.local']);
  });

  it('ouvinte que lança não desfaz a gravação', () => {
    const settings = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    settings.onChange('ha', () => {
      throw new Error('boom');
    });
    settings.update('ha', { token: 'novo' });
    assert.equal(settings.get('ha').token, 'novo');
  });

  it('valida o formato de sala e área no mapeamento', () => {
    const settings = RuntimeSettings.open(base, store, () => EMPTY_OVERRIDES, {});
    settings.update('rooms', { areas: { desktop_diogo: 'escritorio' } });
    assert.deepEqual(settings.get('rooms').areas, { desktop_diogo: 'escritorio' });
    assert.throws(() => settings.update('rooms', { areas: { 'Sala Grande': 'x' } }), SettingsValidationError);
  });
});

describe('máscara de segredos', () => {
  it('nunca devolve o valor, só se está definido e o final quando é longo', () => {
    assert.deepEqual(maskSecret(''), { set: false, last4: null });
    assert.deepEqual(maskSecret('curto'), { set: true, last4: null });
    assert.deepEqual(maskSecret('abcdefghijkl1234'), { set: true, last4: '1234' });
  });

  it('mascara os campos secretos do grupo', () => {
    const masked = maskGroup('ha', { url: 'http://ha', token: 'segredo-muito-longo-a1b2' }) as Record<string, unknown>;
    assert.equal(masked.url, 'http://ha');
    assert.deepEqual(masked.token, { set: true, last4: 'a1b2' });
    assert.ok(!JSON.stringify(masked).includes('segredo'));
  });
});
