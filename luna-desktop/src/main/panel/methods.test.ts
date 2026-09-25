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
  const logs = {
    start: (f: { level: string; room: string | null }) => calls.push(`logs:${f.level}:${f.room}`),
    stop: () => calls.push('logs:stop'),
  };
  return { methods: createPanelMethods({ admin, local: localStub(calls), logs }), recorded, calls };
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
    const methods = createPanelMethods({ admin, local: localStub([]), logs: { start() {}, stop() {} } });
    const result = await methods['server.status']!();
    assert.equal(result.ok, false);
    assert.match((result.body as { error: string }).error, /inacessível/);
  });

  it('não há método genérico: só a whitelist existe', () => {
    const { methods } = setup();
    assert.equal(Object.hasOwn(methods, 'require'), false);
    assert.ok(Object.keys(methods).every((name) => /^(server|local|logs)\./.test(name)));
  });

  it('diagnóstico valida a janela antes de ir à rede', async () => {
    const { methods, recorded } = setup();
    await methods['server.latency']!(168);
    assert.equal(recorded[0]!.url, 'http://192.168.0.20:8080/admin/v1/diagnostics/latency?hours=168');
    const bad = await methods['server.latency']!('24; drop');
    assert.equal(bad.ok, false);
    assert.equal(recorded.length, 1);
  });

  it('lembretes: criar vai por POST com o corpo, editar exige id inteiro', async () => {
    const { methods, recorded } = setup();
    await methods['server.createReminder']!({ room_id: 'quarto', time: '07:00' });
    assert.equal(recorded[0]!.method, 'POST');
    assert.equal(recorded[0]!.url, 'http://192.168.0.20:8080/admin/v1/reminders');
    assert.deepEqual(recorded[0]!.body, { room_id: 'quarto', time: '07:00' });
    await methods['server.editReminder']!(7, { room_id: 'quarto', time: '08:00' });
    assert.equal(recorded[1]!.url, 'http://192.168.0.20:8080/admin/v1/reminders/7');
    assert.equal((await methods['server.editReminder']!('7/../restart', {})).ok, false);
    assert.equal(recorded.length, 2);
  });

  it('dispositivos: patch só com as chaves conhecidas; testar exige on/off', async () => {
    const { methods, recorded } = setup();
    await methods['server.saveDevices']!({ exclude: ['switch.x'], outra: 1 });
    assert.deepEqual(recorded[0]!.body, { exclude: ['switch.x'] });
    assert.equal((await methods['server.saveDevices']!({ exclude: 'switch.x' })).ok, false);
    await methods['server.testDevice']!('light.abajur', 'on');
    assert.deepEqual(recorded[1]!.body, { entity_id: 'light.abajur', action: 'on' });
    assert.equal((await methods['server.testDevice']!('light.abajur', 'toggle')).ok, false);
    assert.equal(recorded.length, 2);
  });

  it('log ao vivo: filtro validado no processo principal', async () => {
    const { methods, calls } = setup();
    assert.equal((await methods['logs.start']!('warn', 'quarto')).ok, true);
    assert.equal((await methods['logs.start']!('warn', '../x')).ok, false);
    assert.equal((await methods['logs.start']!('barulho', null)).ok, false);
    await methods['logs.stop']!();
    assert.deepEqual(calls, ['logs:warn:quarto', 'logs:stop']);
  });
});
