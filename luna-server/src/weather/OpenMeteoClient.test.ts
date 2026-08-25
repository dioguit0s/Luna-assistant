import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { OpenMeteoClient } from './OpenMeteoClient.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Mesmo helper de `ha/HomeAssistantClient.test.ts` — convenção do repo. */
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

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
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

const FULL_BODY = {
  current: {
    temperature_2m: 23.4,
    apparent_temperature: 25.1,
    relative_humidity_2m: 68,
    wind_speed_10m: 11.9,
    weather_code: 3,
  },
  daily: {
    time: ['2026-08-25', '2026-08-26'],
    weather_code: [3, 61],
    temperature_2m_max: [27.1, 24.8],
    temperature_2m_min: [18.2, 17.9],
    precipitation_probability_max: [20, 70],
  },
};

describe('OpenMeteoClient.fetchForecast', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('monta a URL com latitude, longitude, current, daily, timezone e forecast_days', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(FULL_BODY));
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    await client.fetchForecast();

    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
    assert.equal(url.searchParams.get('latitude'), '-23.55');
    assert.equal(url.searchParams.get('longitude'), '-46.63');
    assert.equal(url.searchParams.get('timezone'), 'America/Sao_Paulo');
    assert.equal(url.searchParams.get('forecast_days'), '2');
    assert.match(url.searchParams.get('current') ?? '', /temperature_2m/);
    assert.match(url.searchParams.get('daily') ?? '', /weather_code/);
  });

  it('parseia um corpo completo em snapshot com current e os dois dias, indexados por data', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(FULL_BODY));
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    const snapshot = await client.fetchForecast();

    assert.ok(snapshot);
    assert.equal(snapshot!.current?.temperatureC, 23.4);
    assert.equal(snapshot!.current?.weatherCode, 3);
    assert.equal(snapshot!.daily.length, 2);
    assert.equal(snapshot!.daily[0].date, '2026-08-25');
    assert.equal(snapshot!.daily[0].maxC, 27.1);
    assert.equal(snapshot!.daily[1].date, '2026-08-26');
    assert.equal(snapshot!.daily[1].rainChancePct, 70);
  });

  it('corpo de erro do Open-Meteo ({error:true,reason}) devolve null sem lançar', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ error: true, reason: 'Latitude must be in range of -90 to 90°' }, 400),
    );
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    assert.equal(await client.fetchForecast(), null);
  });

  it('HTTP 500 devolve null sem lançar', async () => {
    const { fetchImpl } = mockFetch(() => textResponse('internal error', 500));
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    assert.equal(await client.fetchForecast(), null);
  });

  it('corpo que não é JSON devolve null sem lançar', async () => {
    const { fetchImpl } = mockFetch(() => textResponse('não é json'));
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    assert.equal(await client.fetchForecast(), null);
  });

  it('daily.time com mais entradas que os demais campos: dia sem par vira null nos campos, sem estourar', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({
        current: FULL_BODY.current,
        daily: { time: ['2026-08-25', '2026-08-26'], weather_code: [3] },
      }),
    );
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    const snapshot = await client.fetchForecast();

    assert.equal(snapshot!.daily.length, 2);
    assert.equal(snapshot!.daily[0].weatherCode, 3);
    assert.equal(snapshot!.daily[1].weatherCode, null);
  });

  it('null dentro de um array vira campo ausente, nunca NaN', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({
        current: FULL_BODY.current,
        daily: { time: ['2026-08-25'], temperature_2m_max: [null] },
      }),
    );
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    const snapshot = await client.fetchForecast();

    assert.equal(snapshot!.daily[0].maxC, null);
  });

  it('current ausente: snapshot só com os dias', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ daily: FULL_BODY.daily }),
    );
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    const snapshot = await client.fetchForecast();

    assert.equal(snapshot!.current, null);
    assert.equal(snapshot!.daily.length, 2);
  });

  it('nem current nem dia válido: null', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({}));
    const client = new OpenMeteoClient(-23.55, -46.63, fetchImpl);

    assert.equal(await client.fetchForecast(), null);
  });

  it('fetch rejeitado devolve null sem lançar', async () => {
    const client = new OpenMeteoClient(-23.55, -46.63, rejectingFetch(new Error('ECONNREFUSED')));
    assert.equal(await client.fetchForecast(), null);
  });

  it('timeout devolve null sem lançar', async () => {
    const client = new OpenMeteoClient(-23.55, -46.63, rejectingFetch(timeoutError()));
    assert.equal(await client.fetchForecast(), null);
  });
});
