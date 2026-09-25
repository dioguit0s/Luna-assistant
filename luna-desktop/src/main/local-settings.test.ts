import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROOM_ID,
  DEFAULT_SERVER_URL,
  LocalSettingsError,
  adminBaseUrl,
  applyLocalPatch,
  connectionChanged,
  resolveLocalSettings,
  type SecretCodec,
} from './local-settings.js';

/** Cifra de mentira, reversível e visível: prova que o valor gravado não é o texto puro. */
const codec: SecretCodec = {
  available: () => true,
  encrypt: (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: (encoded) => {
    if (!encoded.startsWith('enc:')) throw new Error('não decifra');
    return Buffer.from(encoded.slice(4), 'base64').toString();
  },
};

describe('preferências do painel v2', () => {
  const codec = { available: () => true, encrypt: (s: string) => s, decrypt: (s: string) => s };

  it('limiar na faixa, null volta ao default', () => {
    let stored = applyLocalPatch({}, { wakeThreshold: 0.9 }, codec);
    assert.equal(resolveLocalSettings({}, stored, codec).wakeThreshold, 0.9);
    assert.throws(() => applyLocalPatch({}, { wakeThreshold: 0.2 }, codec), LocalSettingsError);
    stored = applyLocalPatch(stored, { wakeThreshold: null }, codec);
    assert.equal(resolveLocalSettings({}, stored, codec).wakeThreshold, null);
  });

  it('atalho exige modificador; vazio desliga', () => {
    let stored = applyLocalPatch({}, { talkShortcut: 'Control+Shift+Space' }, codec);
    assert.equal(stored.talkShortcut, 'Control+Shift+Space');
    stored = applyLocalPatch(stored, { talkShortcut: 'F9' }, codec);
    assert.equal(stored.talkShortcut, 'F9');
    assert.throws(() => applyLocalPatch({}, { talkShortcut: 'A' }, codec), LocalSettingsError);
    assert.throws(() => applyLocalPatch({}, { talkShortcut: 'Shift+!' }, codec), LocalSettingsError);
    assert.throws(() => applyLocalPatch({}, { talkShortcut: 'Control+Alt+AltRight' }, codec), LocalSettingsError);
    assert.equal(applyLocalPatch({}, { talkShortcut: 'Control+Up' }, codec).talkShortcut, 'Control+Up');
    stored = applyLocalPatch(stored, { talkShortcut: '' }, codec);
    assert.equal(resolveLocalSettings({}, stored, codec).talkShortcut, '');
  });

  it('notificações ligadas por padrão', () => {
    assert.equal(resolveLocalSettings({}, {}, codec).reminderNotifications, true);
    const off = applyLocalPatch({}, { reminderNotifications: false }, codec);
    assert.equal(resolveLocalSettings({}, off, codec).reminderNotifications, false);
  });
});

describe('resolveLocalSettings', () => {
  it('sem nada configurado usa os defaults e diz que não há segredo', () => {
    const r = resolveLocalSettings({}, {}, codec);
    assert.equal(r.serverUrl, DEFAULT_SERVER_URL);
    assert.equal(r.roomId, DEFAULT_ROOM_ID);
    assert.equal(r.authSecret, '');
    assert.equal(r.sources.authSecret, 'none');
  });

  it('o .env semeia quando o painel ainda não gravou nada', () => {
    const r = resolveLocalSettings(
      { WS_SERVER_URL: 'ws://10.0.0.2:8080', ROOM_ID: 'escritorio', WS_AUTH_SECRET: 's', LUNA_ADMIN_TOKEN: 't' },
      {},
      codec,
    );
    assert.equal(r.serverUrl, 'ws://10.0.0.2:8080');
    assert.equal(r.roomId, 'escritorio');
    assert.equal(r.authSecret, 's');
    assert.deepEqual(r.sources, { authSecret: 'env', adminToken: 'env' });
  });

  it('o que o painel gravou vence o .env', () => {
    const stored = applyLocalPatch({}, { serverUrl: 'ws://casa:9000', authSecret: 'do-painel' }, codec);
    const r = resolveLocalSettings({ WS_SERVER_URL: 'ws://outro:8080', WS_AUTH_SECRET: 'do-env' }, stored, codec);
    assert.equal(r.serverUrl, 'ws://casa:9000');
    assert.equal(r.authSecret, 'do-painel');
    assert.equal(r.sources.authSecret, 'panel');
  });

  it('segredo que não decifra (outro usuário do Windows) cai para o .env em vez de travar', () => {
    const r = resolveLocalSettings({ WS_AUTH_SECRET: 'do-env' }, { secrets: { authSecret: 'lixo' } }, codec);
    assert.equal(r.authSecret, 'do-env');
    assert.equal(r.sources.authSecret, 'env');
  });
});

describe('applyLocalPatch', () => {
  it('grava o segredo cifrado, nunca em claro', () => {
    const stored = applyLocalPatch({}, { adminToken: 'meu-token' }, codec);
    assert.notEqual(stored.secrets?.adminToken, 'meu-token');
    assert.ok(!JSON.stringify(stored).includes('meu-token'));
  });

  it('segredo ausente no patch mantém; string vazia apaga', () => {
    const one = applyLocalPatch({}, { authSecret: 'a' }, codec);
    const kept = applyLocalPatch(one, { roomId: 'quarto' }, codec);
    assert.equal(kept.secrets?.authSecret, one.secrets?.authSecret);
    const cleared = applyLocalPatch(kept, { authSecret: '' }, codec);
    assert.equal(cleared.secrets?.authSecret, undefined);
  });

  it('recusa gravar segredo quando o cofre do sistema não está disponível', () => {
    const noVault: SecretCodec = { ...codec, available: () => false };
    assert.throws(() => applyLocalPatch({}, { authSecret: 'x' }, noVault), LocalSettingsError);
  });

  it('valida URL do servidor e formato da sala', () => {
    assert.throws(
      () => applyLocalPatch({}, { serverUrl: 'http://casa:8080' }, codec),
      (err: unknown) => err instanceof LocalSettingsError && err.field === 'serverUrl',
    );
    assert.throws(
      () => applyLocalPatch({}, { roomId: 'Sala Grande' }, codec),
      (err: unknown) => err instanceof LocalSettingsError && err.field === 'roomId',
    );
    assert.equal(applyLocalPatch({}, { serverUrl: 'wss://casa:8443/' }, codec).serverUrl, 'wss://casa:8443');
  });
});

describe('adminBaseUrl', () => {
  it('troca ws→http e wss→https, sem caminho', () => {
    assert.equal(adminBaseUrl('ws://192.168.0.20:8080'), 'http://192.168.0.20:8080');
    assert.equal(adminBaseUrl('wss://luna.casa:8443/ws'), 'https://luna.casa:8443');
  });
});

describe('connectionChanged', () => {
  it('só servidor, sala e segredo exigem reconectar', () => {
    const base = resolveLocalSettings({ WS_AUTH_SECRET: 's' }, {}, codec);
    assert.equal(connectionChanged(base, { ...base, micDeviceId: 'x', adminToken: 'y' }), false);
    assert.equal(connectionChanged(base, { ...base, roomId: 'quarto' }), true);
    assert.equal(connectionChanged(base, { ...base, authSecret: 'outro' }), true);
  });
});
