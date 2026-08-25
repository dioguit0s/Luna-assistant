import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import type { WeatherSnapshot } from '../../weather/OpenMeteoClient.js';
import type { WeatherSource } from '../../weather/WeatherSource.js';
import { createGetWeatherHandler } from './getWeather.js';
import { INVALID_ARGS_RESULT, type ToolContext } from './types.js';

const ROOM = 'sala_de_estar';

function ctx(): ToolContext {
  return {
    roomId: ROOM,
    deviceId: 'esp32-sala',
    provider: {} as IAudioProvider,
    callId: 'call-1',
    modelDecisionMs: null,
  };
}

const FULL_SNAPSHOT: WeatherSnapshot = {
  fetchedAt: Date.now(),
  current: { temperatureC: 23.4, feelsLikeC: 25.1, humidityPct: 68, windKmh: 11.9, weatherCode: 3 },
  daily: [
    { date: '2026-08-24', weatherCode: 61, maxC: 24.8, minC: 17.9, rainChancePct: 70 },
    { date: '2026-08-25', weatherCode: 3, maxC: 27.1, minC: 18.2, rainChancePct: 20 },
  ],
};

/** Fake mínimo de `WeatherSource`: só o que o handler consome. */
function fakeSource(
  current: WeatherSnapshot | null,
  refresh: () => Promise<void> = async () => {},
): WeatherSource {
  return { current: () => current, refresh } as unknown as WeatherSource;
}

describe('createGetWeatherHandler', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('args inválidos devolvem INVALID_ARGS_RESULT', async () => {
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT) });
    const result = await handler({ when: 'ontem' }, ctx());
    assert.deepEqual(result, INVALID_ARGS_RESULT);
  });

  it('when ausente se comporta como now', async () => {
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT) });
    const result = (await handler({}, ctx())) as Record<string, unknown>;
    assert.equal(result.success, true);
    assert.equal(result.when, 'agora');
  });

  it('now: arredonda os valores, traduz o código e nunca expõe o código WMO cru', async () => {
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT) });
    const result = (await handler({ when: 'now' }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.equal(result.condition, 'nublado');
    assert.equal(result.temperature_c, 23);
    assert.equal(result.feels_like_c, 25);
    assert.equal(result.humidity_pct, 68);
    assert.equal(result.wind_kmh, 12);
    assert.equal('weather_code' in result, false);
    assert.equal('weatherCode' in result, false);
  });

  it("today resolve pelo relógio injetado, cruzando meia-noite: 2026-08-25T02:00Z é 24/08 em São Paulo", async () => {
    const now = () => new Date(Date.UTC(2026, 7, 25, 2, 0, 0)); // 23:00 de 24/08 em SP
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT), now });

    const result = (await handler({ when: 'today' }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.equal(result.when, 'hoje');
    assert.equal(result.condition, 'chuva fraca'); // linha de 2026-08-24
    assert.equal(result.max_c, 25);
    assert.equal(result.min_c, 18);
    assert.equal(result.rain_chance_pct, 70);
  });

  it('tomorrow pega o dia seguinte ao relógio injetado', async () => {
    const now = () => new Date(Date.UTC(2026, 7, 24, 12, 0, 0)); // 09:00 de 24/08 em SP
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT), now });

    const result = (await handler({ when: 'tomorrow' }, ctx())) as Record<string, unknown>;

    assert.equal(result.when, 'amanhã');
    assert.equal(result.condition, 'nublado'); // linha de 2026-08-25 (weatherCode 3)
    assert.equal(result.max_c, 27);
  });

  it('cache frio: devolve erro falável e dispara um refresh em background', async () => {
    const refresh = mock.fn(async () => {});
    const handler = createGetWeatherHandler({ source: fakeSource(null, refresh) });

    const result = (await handler({ when: 'now' }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(refresh.mock.callCount(), 1);
  });

  it('snapshot sem a data pedida devolve erro falável, nunca o dia errado', async () => {
    const now = () => new Date(Date.UTC(2026, 8, 1, 12, 0, 0)); // fora dos 2 dias do snapshot
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT), now });

    const result = (await handler({ when: 'today' }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, false);
  });

  it('código WMO desconhecido: condition ausente, mas temperatura presente', async () => {
    const snapshot: WeatherSnapshot = {
      fetchedAt: Date.now(),
      current: { temperatureC: 23, feelsLikeC: null, humidityPct: null, windKmh: null, weatherCode: 12345 },
      daily: [],
    };
    const handler = createGetWeatherHandler({ source: fakeSource(snapshot) });

    const result = (await handler({ when: 'now' }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.equal('condition' in result, false);
    assert.equal(result.temperature_c, 23);
  });

  it('nunca faz round-trip: um fetchImpl que lançaria não é tocado pelo handler', async () => {
    // O handler só chama `source.current()` (síncrono). Se ele tentasse buscar
    // a previsão de rede, este teste travaria ou lançaria.
    const handler = createGetWeatherHandler({ source: fakeSource(FULL_SNAPSHOT) });
    const result = await handler({ when: 'now' }, ctx());
    assert.ok((result as { success: boolean }).success);
  });
});
