import { getLogger } from '../logging/logger.js';
import type { NowFn } from '../time/clock.js';
import { systemNow } from '../time/clock.js';
import type { OpenMeteoClient, WeatherSnapshot } from './OpenMeteoClient.js';

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Teto de idade além do qual um snapshot não é mais confiável para ser dito
 * em voz — três horas de silêncio na revalidação (Open-Meteo fora do ar,
 * `refresh` nunca chamado) já não garante que "vinte e três graus" ainda seja
 * verdade. Diferente do `DeviceRegistrySource`, onde um registro velho ainda é
 * útil: aqui o dado tem prazo de validade.
 */
const DEFAULT_MAX_STALE_MS = 3 * 60 * 60_000;

/**
 * Mantém um snapshot do Open-Meteo atualizado em memória, para que
 * `getWeather` (o handler da tool) nunca precise de um round-trip de rede no
 * caminho fala→resposta — o mesmo desenho de `DeviceRegistrySource` para o
 * Home Assistant.
 *
 * Nunca lança: HA e Open-Meteo fora do ar degradam para o último snapshot
 * conhecido, nunca para uma exceção que derrubaria a sessão.
 */
export class WeatherSource {
  private snapshot: WeatherSnapshot | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Uma rajada de cache-miss não pode virar uma rajada de requisições. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly client: OpenMeteoClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxStaleMs: number = DEFAULT_MAX_STALE_MS,
    private readonly now: NowFn = systemNow,
  ) {}

  /** Primeira busca e agendamento do refresh periódico. */
  async start(): Promise<void> {
    await this.refresh();

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.ttlMs);
    // Não segurar o processo vivo só pelo refresh da previsão.
    this.refreshTimer.unref();
  }

  /**
   * Snapshot atual, ou `null` se nunca buscou com sucesso ou se o último
   * sucesso já passou de `maxStaleMs`. Chame a cada uso em vez de guardar a
   * referência — mesma regra do `DeviceRegistrySource.current()`.
   */
  current(): WeatherSnapshot | null {
    if (this.snapshot === null) return null;
    const ageMs = this.now().getTime() - this.snapshot.fetchedAt;
    if (ageMs > this.maxStaleMs) return null;
    return this.snapshot;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const fetched = await this.client.fetchForecast();

    if (fetched === null) {
      getLogger().warn(
        { event: 'weather_refresh', had_snapshot: this.snapshot !== null },
        'Consulta ao Open-Meteo falhou: mantendo o snapshot anterior',
      );
      return;
    }

    this.snapshot = fetched;
    getLogger().info(
      { event: 'weather_refresh', days: fetched.daily.length },
      `Previsão do tempo atualizada: ${fetched.daily.length} dias`,
    );
  }
}
