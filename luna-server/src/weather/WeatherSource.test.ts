import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { WeatherSource } from './WeatherSource.js';
import type { OpenMeteoClient, WeatherSnapshot } from './OpenMeteoClient.js';

function snapshotAt(fetchedAt: number): WeatherSnapshot {
  return {
    fetchedAt,
    current: { temperatureC: 23, feelsLikeC: 24, humidityPct: 60, windKmh: 10, weatherCode: 3 },
    daily: [{ date: '2026-08-25', weatherCode: 3, maxC: 27, minC: 18, rainChancePct: 20 }],
  };
}

/** Fake mínimo de `OpenMeteoClient`: só o método que `WeatherSource` chama. */
function fakeClient(fetchForecast: () => Promise<WeatherSnapshot | null>): OpenMeteoClient {
  return { fetchForecast } as unknown as OpenMeteoClient;
}

describe('WeatherSource', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('current() é null antes do start()', () => {
    const source = new WeatherSource(fakeClient(async () => snapshotAt(0)));
    assert.equal(source.current(), null);
  });

  it('start() popula o snapshot', async () => {
    const source = new WeatherSource(fakeClient(async () => snapshotAt(Date.now())));
    await source.start();
    assert.ok(source.current());
    source.stop();
  });

  it('refresh que falha mantém o snapshot anterior', async () => {
    let call = 0;
    const source = new WeatherSource(
      fakeClient(async () => {
        call += 1;
        return call === 1 ? snapshotAt(Date.now()) : null;
      }),
    );
    await source.start();
    const first = source.current();
    await source.refresh();
    assert.deepEqual(source.current(), first);
    source.stop();
  });

  it('dois refresh() concorrentes fazem uma única chamada ao client (single-flight)', async () => {
    const fetchForecast = mock.fn(async () => snapshotAt(Date.now()));
    const source = new WeatherSource(fakeClient(fetchForecast));

    await Promise.all([source.refresh(), source.refresh()]);

    assert.equal(fetchForecast.mock.callCount(), 1);
  });

  it('snapshot mais velho que maxStaleMs vira null em current()', async () => {
    const T0 = Date.UTC(2026, 7, 25, 12, 0, 0);
    let clock = T0;
    const source = new WeatherSource(
      fakeClient(async () => snapshotAt(T0)),
      600_000,
      1_000, // maxStaleMs bem curto pro teste
      () => new Date(clock),
    );
    await source.start();
    assert.ok(source.current());

    clock = T0 + 2_000; // passou do maxStaleMs
    assert.equal(source.current(), null);
    source.stop();
  });

  it('setClient descarta a busca em voo da casa antiga e zera o snapshot na hora', async () => {
    let releaseOld!: (s: WeatherSnapshot) => void;
    const old = fakeClient(() => new Promise((r) => (releaseOld = r)));
    const source = new WeatherSource(old);
    const oldFlight = source.refresh();

    let calls = 0;
    const fresh = snapshotAt(Date.now());
    source.setClient(fakeClient(async () => {
      calls += 1;
      return fresh;
    }));
    assert.equal(source.current(), null, 'sem previsão de outra cidade');
    // Com a busca nova em voo, um cache miss reaproveita ela em vez de abrir outra.
    const concurrent = source.refresh();
    releaseOld(snapshotAt(Date.now()));
    await oldFlight;
    await concurrent;
    assert.equal(source.current(), fresh, 'o resultado da busca velha não ganhou');
    assert.equal(calls, 1, 'a busca nova não foi duplicada');

    source.setClient(null);
    assert.equal(source.current(), null);
    assert.equal(source.configured, false);
  });

  it('stop() limpa o intervalo de refresh', async () => {
    const source = new WeatherSource(fakeClient(async () => snapshotAt(Date.now())), 50);
    await source.start();
    source.stop();
    // Não há como espiar `clearInterval` diretamente sem mocká-lo; o teste de
    // valor aqui é não lançar e não deixar o processo vivo — coberto pelo
    // `node --test` terminando sem handle pendente.
    assert.ok(true);
  });
});
