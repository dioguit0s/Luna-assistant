import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdminClient } from '../admin/client.js';
import { createPanelMethods, type LocalControls, type LocalView } from './methods.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, body: unknown, recorded: Recorded[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    recorded.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const VIEW = { roomId: 'desktop_diogo' } as LocalView;

function localStub(calls: string[]): LocalControls {
  return {
    view: () => VIEW,
    save: async (patch) => {
      calls.push(`save:${JSON.stringify(patch)}`);
      return VIEW;
    },
    setMuted: (m) => calls.push(`muted:${m}`),
    forceListen: () => calls.push('force'),
    setAutostart: (e) => calls.push(`autostart:${e}`),
    openDataDir: () => calls.push('dir'),
    listAudioDevices: async () => [],
  };
}

function setup(status = 200, body: unknown = { ok: true }, token = 'tok') {
  const recorded: Recorded[] = [];
  const calls: string[] = [];
  const admin = new AdminClient(
    () => ({ serverUrl: 'ws://192.168.0.20:8080', adminToken: token }),
    fakeFetch(status, body, recorded),
  );
  return { methods: createPanelMethods({ admin, local: localStub(calls) }), recorded, calls };
}

describe('métodos do painel', () => {
  it('chamam a API admin na porta do WebSocket, com o token do processo principal', async () => {
    const { methods, recorded } = setup();
    const result = await methods['server.status']!();
    assert.equal(result.ok, true);
    assert.equal(recorded[0]!.url, 'http://192.168.0.20:8080/admin/v1/status');
    assert.equal(recorded[0]!.headers.authorization, 'Bearer tok');
  });

  it('escapa ids no caminho', async () => {
    const { methods, recorded } = setup();
    await methods['server.renameSatellite']!('a/b c', 'Quarto');
    assert.equal(recorded[0]!.url, 'http://192.168.0.20:8080/admin/v1/satellites/a%2Fb%20c');
    assert.deepEqual(recorded[0]!.body, { name: 'Quarto' });
  });

  it('recusa grupo de configuração fora da lista sem chamar o servidor', async () => {
    const { methods, recorded } = setup();
    const result = await methods['server.saveSettings']!('rooms', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(recorded.length, 0);
  });

  it('recusa argumento do tipo errado sem lançar', async () => {
    const { methods, calls } = setup();
    const result = await methods['local.setMuted']!('sim');
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  });

  it('sem token admin nem tenta a rede, e explica onde resolver', async () => {
    const { methods, recorded } = setup(200, {}, '');
    const result = await methods['server.status']!();
    assert.equal(result.ok, false);
    assert.match((result.body as { error: string }).error, /Este computador/);
    assert.equal(recorded.length, 0);
  });

  it('401 do servidor vira instrução para o usuário', async () => {
    const { methods } = setup(401, { error: 'token inválido' });
    const result = await methods['server.status']!();
    assert.equal(result.ok, false);
    assert.match((result.body as { error: string }).error, /LUNA_ADMIN_TOKEN/);
  });

  it('422 preserva o campo culpado', async () => {
    const { methods } = setup(422, { error: 'URL inválida', field: 'url' });
    const result = await methods['server.saveSettings']!('ha', { url: 'x' });
    assert.equal((result.body as { field: string }).field, 'url');
  });

  it('servidor fora do ar não lança: vira mensagem', async () => {
    const admin = new AdminClient(
      () => ({ serverUrl: 'ws://192.168.0.20:8080', adminToken: 'tok' }),
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    );
    const methods = createPanelMethods({ admin, local: localStub([]) });
    const result = await methods['server.status']!();
    assert.equal(result.ok, false);
    assert.match((result.body as { error: string }).error, /inacessível/);
  });

  it('não há método genérico: só a whitelist existe', () => {
    const { methods } = setup();
    assert.equal(Object.hasOwn(methods, 'require'), false);
    assert.ok(Object.keys(methods).every((name) => /^(server|local)\./.test(name)));
  });
});
