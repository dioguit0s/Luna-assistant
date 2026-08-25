import { getLogger } from '../logging/logger.js';
import { LUNA_TIME_ZONE } from '../time/clock.js';

/** O áudio é tempo real: mesmo teto de `HomeAssistantClient` para qualquer HTTP externo. */
const DEFAULT_TIMEOUT_MS = 3000;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** Previsão de um único dia, já indexada pela data (`YYYY-MM-DD`, hora de São Paulo). */
export interface DailyForecast {
  date: string;
  weatherCode: number | null;
  maxC: number | null;
  minC: number | null;
  rainChancePct: number | null;
}

/** Snapshot cru de uma consulta ao Open-Meteo — ainda em graus decimais, sem tradução. */
export interface WeatherSnapshot {
  fetchedAt: number;
  current: {
    temperatureC: number | null;
    feelsLikeC: number | null;
    humidityPct: number | null;
    windKmh: number | null;
    weatherCode: number | null;
  } | null;
  /** Por data (`YYYY-MM-DD`), nunca por posição — ver `WeatherSource`. */
  daily: DailyForecast[];
}

/**
 * Cliente HTTP do Open-Meteo. Sem API key, sem autenticação.
 *
 * Nenhum método lança: o Open-Meteo fora do ar não pode derrubar o turno do
 * usuário — mesma convenção de `HomeAssistantClient`. Quem consome (`WeatherSource`)
 * degrada para o último snapshot conhecido.
 */
export class OpenMeteoClient {
  constructor(
    private readonly latitude: number,
    private readonly longitude: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetchForecast(): Promise<WeatherSnapshot | null> {
    const url = this.buildUrl();
    const startedAt = Date.now();

    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const latencyMs = Date.now() - startedAt;
      const body: unknown = await res.json().catch(() => null);

      // O Open-Meteo sinaliza erro no próprio corpo (`{"error":true,"reason":"..."}`),
      // inclusive fora do caso `!res.ok` — checar isso primeiro evita interpretar
      // um corpo de erro como se fosse uma previsão vazia.
      if (isErrorBody(body)) {
        getLogger().warn(
          { event: 'weather_fetch', status: res.status, latency_ms: latencyMs, reason: body.reason },
          `Open-Meteo recusou a consulta: ${body.reason}`,
        );
        return null;
      }

      if (!res.ok || body === null) {
        getLogger().warn(
          { event: 'weather_fetch', status: res.status, latency_ms: latencyMs },
          `Open-Meteo respondeu ${res.status}`,
        );
        return null;
      }

      const snapshot = this.parseSnapshot(body);
      if (snapshot === null) {
        getLogger().warn(
          { event: 'weather_fetch', status: res.status, latency_ms: latencyMs },
          'Resposta do Open-Meteo sem dado aproveitável',
        );
        return null;
      }

      getLogger().info(
        {
          event: 'weather_fetch',
          status: res.status,
          latency_ms: latencyMs,
          days: snapshot.daily.length,
        },
        `Open-Meteo: previsão atualizada (${snapshot.daily.length} dias)`,
      );
      return snapshot;
    } catch (err) {
      getLogger().warn(
        {
          event: 'weather_fetch',
          latency_ms: Date.now() - startedAt,
          err: this.describeFailure(err),
        },
        'Falha ao consultar o Open-Meteo',
      );
      return null;
    }
  }

  private buildUrl(): string {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set('latitude', String(this.latitude));
    url.searchParams.set('longitude', String(this.longitude));
    url.searchParams.set(
      'current',
      'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    );
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    // Explícito, não "auto": o resto do servidor tem um relógio só (ADR 006),
    // fixado em `LUNA_TIME_ZONE` — os limites de dia do `daily` têm que casar
    // com o mesmo fuso que resolve "hoje"/"amanhã" no handler.
    url.searchParams.set('timezone', LUNA_TIME_ZONE);
    url.searchParams.set('forecast_days', '2');
    url.searchParams.set('temperature_unit', 'celsius');
    url.searchParams.set('wind_speed_unit', 'kmh');
    return url.toString();
  }

  /**
   * Parsing defensivo: campo ausente ou de tipo errado vira `null` naquele
   * campo específico, nunca derruba o snapshot inteiro. `daily` é montado por
   * data (`time[i]`), não por posição pura — quem lê por posição errada é
   * quem chama `parseSnapshot`, não este método (ele já entrega `date` junto).
   */
  private parseSnapshot(body: unknown): WeatherSnapshot | null {
    if (typeof body !== 'object' || body === null) return null;
    const { current, daily } = body as Record<string, unknown>;

    const parsedCurrent = parseCurrent(current);
    const parsedDaily = parseDaily(daily);

    if (parsedCurrent === null && parsedDaily.length === 0) return null;

    return { fetchedAt: Date.now(), current: parsedCurrent, daily: parsedDaily };
  }

  private describeFailure(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return `timeout após ${this.timeoutMs}ms`;
      }
      return err.message;
    }
    return 'erro desconhecido';
  }
}

function isErrorBody(body: unknown): body is { error: true; reason: string } {
  if (typeof body !== 'object' || body === null) return false;
  const { error, reason } = body as Record<string, unknown>;
  return error === true && typeof reason === 'string';
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCurrent(current: unknown): WeatherSnapshot['current'] {
  if (typeof current !== 'object' || current === null) return null;
  const row = current as Record<string, unknown>;
  return {
    temperatureC: toNumberOrNull(row.temperature_2m),
    feelsLikeC: toNumberOrNull(row.apparent_temperature),
    humidityPct: toNumberOrNull(row.relative_humidity_2m),
    windKmh: toNumberOrNull(row.wind_speed_10m),
    weatherCode: toNumberOrNull(row.weather_code),
  };
}

/**
 * `daily` chega em colunas paralelas (`time: [...]`, `weather_code: [...]`, ...),
 * não em linhas. Monta uma linha por entrada de `time`, e um array mais curto
 * (dia sem par, valor `null`) não estoura — só falta aquele campo naquele dia.
 */
function parseDaily(daily: unknown): DailyForecast[] {
  if (typeof daily !== 'object' || daily === null) return [];
  const row = daily as Record<string, unknown>;
  const dates = row.time;
  if (!Array.isArray(dates)) return [];

  const weatherCodes = Array.isArray(row.weather_code) ? row.weather_code : [];
  const maxTemps = Array.isArray(row.temperature_2m_max) ? row.temperature_2m_max : [];
  const minTemps = Array.isArray(row.temperature_2m_min) ? row.temperature_2m_min : [];
  const rainChances = Array.isArray(row.precipitation_probability_max)
    ? row.precipitation_probability_max
    : [];

  const forecasts: DailyForecast[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (typeof date !== 'string') continue;
    forecasts.push({
      date,
      weatherCode: toNumberOrNull(weatherCodes[i]),
      maxC: toNumberOrNull(maxTemps[i]),
      minC: toNumberOrNull(minTemps[i]),
      rainChancePct: toNumberOrNull(rainChances[i]),
    });
  }
  return forecasts;
}
