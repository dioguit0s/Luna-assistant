import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { HomeAssistantClient } from './HomeAssistantClient.js';

const baseConfig: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'test-key',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0,
  logLevel: 'silent',
  geminiLiveModel: 'test-model',
  openaiRealtimeModel: 'test-model',
  haUrl: 'http://ha.local:8123',
  haToken: 'token-de-teste',
  devicesConfigPath: 'config/devices.json',
  deviceRegistryTtlMs: 300_000,
  geminiVadSilenceMs: null,
  geminiVadEndSensitivity: null,
  geminiManualActivity: false,
  geminiDebugMessages: false,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Mock de `fetch` que registra as chamadas e devolve o que o teste mandar. */
function mockFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rejectingFetch(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

describe('HomeAssistantClient.callService', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('monta a requisição e retorna sucesso em 200', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([]));
    const client = new HomeAssistantClient(baseConfig, fetchImpl);

    const result = await client.callService('switch', 'turn_on', 'switch.luz_bancada');

    assert.deepEqual(result, { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://ha.local:8123/api/services/switch/turn_on');
    assert.equal(calls[0]!.init.method, 'POST');

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer token-de-teste');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      entity_id: 'switch.luz_bancada',
    });
  });

  it('remove barra final do HA_URL', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([]));
    const client = new HomeAssistantClient(
      { ...baseConfig, haUrl: 'http://ha.local:8123/' },
      fetchImpl,
    );

    await client.callService('switch', 'turn_off', 'switch.luz_bancada');

    assert.equal(calls[0]!.url, 'http://ha.local:8123/api/services/switch/turn_off');
  });

  for (const status of [401, 404, 500, 502]) {
    it(`retorna erro sem lançar em ${status}`, async () => {
      const { fetchImpl } = mockFetch(() => new Response('', { status }));
      const client = new HomeAssistantClient(baseConfig, fetchImpl);

      const result = await client.callService('switch', 'turn_on', 'switch.luz_bancada');

      assert.equal(result.success, false);
      assert.match(result.error ?? '', new RegExp(String(status)));
    });
  }

  it('retorna erro de timeout sem lançar', async () => {
    const client = new HomeAssistantClient(
      baseConfig,
      rejectingFetch(timeoutError()),
      1500,
    );

    const result = await client.callService('switch', 'turn_on', 'switch.luz_bancada');

    assert.equal(result.success, false);
    assert.equal(result.error, 'timeout após 1500ms');
  });

  it('retorna erro de rede sem lançar', async () => {
    const client = new HomeAssistantClient(
      baseConfig,
      rejectingFetch(new TypeError('fetch failed')),
    );

    const result = await client.callService('switch', 'turn_on', 'switch.luz_bancada');

    assert.deepEqual(result, { success: false, error: 'fetch failed' });
  });

  it('não chama a rede quando HA_URL/HA_TOKEN estão vazios', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([]));
    const client = new HomeAssistantClient(
      { ...baseConfig, haUrl: '', haToken: '' },
      fetchImpl,
    );

    const result = await client.callService('switch', 'turn_on', 'switch.luz_bancada');

    assert.deepEqual(result, {
      success: false,
      error: 'Home Assistant não configurado',
    });
    assert.equal(calls.length, 0);
  });
});

describe('HomeAssistantClient.getState', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('retorna o estado em 200', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ entity_id: 'switch.luz_bancada', state: 'on' }),
    );
    const client = new HomeAssistantClient(baseConfig, fetchImpl);

    const state = await client.getState('switch.luz_bancada');

    assert.equal(state, 'on');
    assert.equal(calls[0]!.url, 'http://ha.local:8123/api/states/switch.luz_bancada');
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
      'Bearer token-de-teste',
    );
  });

  it('retorna null em 404', async () => {
    const { fetchImpl } = mockFetch(() => new Response('', { status: 404 }));
    const client = new HomeAssistantClient(baseConfig, fetchImpl);

    assert.equal(await client.getState('switch.inexistente'), null);
  });

  it('retorna null em timeout, sem lançar', async () => {
    const client = new HomeAssistantClient(baseConfig, rejectingFetch(timeoutError()));

    assert.equal(await client.getState('switch.luz_bancada'), null);
  });

  it('retorna null quando a resposta não tem campo state', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ entity_id: 'x' }));
    const client = new HomeAssistantClient(baseConfig, fetchImpl);

    assert.equal(await client.getState('switch.luz_bancada'), null);
  });
});
