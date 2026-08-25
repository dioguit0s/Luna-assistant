import type { WeatherSource } from '../../weather/WeatherSource.js';
import type { DailyForecast, WeatherSnapshot } from '../../weather/OpenMeteoClient.js';
import { isGetWeatherArgs, type WeatherWhen } from '../../weather/tools.js';
import { describeWeatherCode } from '../../weather/wmo.js';
import { getLogger } from '../../logging/logger.js';
import type { NowFn } from '../../time/clock.js';
import { formatLocalDate, localDateTime, localWallClockToUtc, systemNow } from '../../time/clock.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

/** Um dia local dura sempre 24h reais sem DST — mesma conta de `resolveOnce.ts`. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GetWeatherDeps {
  source: WeatherSource;
  /** Injetável para teste, mesmo padrão do resto do servidor. */
  now?: NowFn;
}

/**
 * Handler de `get_weather`. Nunca faz I/O de rede: lê o snapshot em memória de
 * `WeatherSource`, que já foi buscado em background. Um `await` a
 * `api.open-meteo.com` (150-400 ms) no caminho fala→resposta violaria a mesma
 * regra que `controlDevice.ts` documenta — ali o `await` é aceitável só porque
 * é LAN a 20-40 ms.
 */
export function createGetWeatherHandler(deps: GetWeatherDeps): ToolHandler {
  const now = deps.now ?? systemNow;

  return async (args, ctx) => {
    if (!isGetWeatherArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: 'get_weather', args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    const when: WeatherWhen = args.when ?? 'now';
    const snapshot = deps.source.current();

    if (snapshot === null) {
      // Cache frio (boot recente, ou Open-Meteo fora do ar além do teto de
      // idade) — dispara uma tentativa em background para a próxima pergunta
      // ter chance de acertar, sem fazer o turno atual esperar por ela.
      void deps.source.refresh();
      getLogger().warn(
        { event: 'weather_miss', room_id: ctx.roomId, reason: 'no_snapshot' },
        'Consulta de tempo sem snapshot disponível',
      );
      return { success: false, error: 'não consegui consultar a previsão agora' };
    }

    if (when === 'now') {
      return buildNowResult(snapshot, now());
    }

    const targetDate = when === 'tomorrow' ? tomorrowDate(now()) : formatLocalDate(now());
    const day = snapshot.daily.find((d) => d.date === targetDate);

    if (!day) {
      getLogger().warn(
        { event: 'weather_miss', room_id: ctx.roomId, reason: 'no_day', target_date: targetDate },
        `Snapshot sem previsão para ${targetDate}`,
      );
      return { success: false, error: 'não consegui consultar a previsão agora' };
    }

    return buildDayResult(when, day);
  };
}

function tomorrowDate(instant: Date): string {
  const today = localDateTime(instant);
  const todayMidnightUtc = localWallClockToUtc({ ...today, hour: 0, minute: 0, second: 0 });
  return formatLocalDate(new Date(todayMidnightUtc + DAY_MS));
}

function buildNowResult(snapshot: WeatherSnapshot, instant: Date): Record<string, unknown> {
  const { current } = snapshot;
  const todayDate = formatLocalDate(instant);
  const today = snapshot.daily.find((d) => d.date === todayDate);

  const result: Record<string, unknown> = { success: true, when: 'agora' };
  let hasData = false;

  if (current) {
    const condicao = describeWeatherCode(current.weatherCode);
    if (condicao) {
      result.condition = condicao;
      hasData = true;
    }
    if (current.temperatureC !== null) {
      result.temperature_c = Math.round(current.temperatureC);
      hasData = true;
    }
    if (current.feelsLikeC !== null) result.feels_like_c = Math.round(current.feelsLikeC);
    if (current.humidityPct !== null) result.humidity_pct = Math.round(current.humidityPct);
    if (current.windKmh !== null) result.wind_kmh = Math.round(current.windKmh);
  }

  // De brinde, do mesmo snapshot: evita uma segunda tool call quando a
  // pergunta emenda "e vai chover?" logo depois de "como está lá fora?".
  if (today) {
    if (today.maxC !== null) {
      result.today_max_c = Math.round(today.maxC);
      hasData = true;
    }
    if (today.minC !== null) result.today_min_c = Math.round(today.minC);
    if (today.rainChancePct !== null) result.rain_chance_pct = Math.round(today.rainChancePct);
  }

  if (!hasData) {
    return { success: false, error: 'não consegui consultar a previsão agora' };
  }

  return result;
}

function buildDayResult(when: 'today' | 'tomorrow', day: DailyForecast): Record<string, unknown> {
  const result: Record<string, unknown> = {
    success: true,
    when: when === 'today' ? 'hoje' : 'amanhã',
  };

  const condicao = describeWeatherCode(day.weatherCode);
  if (condicao) result.condition = condicao;
  if (day.maxC !== null) result.max_c = Math.round(day.maxC);
  if (day.minC !== null) result.min_c = Math.round(day.minC);
  if (day.rainChancePct !== null) result.rain_chance_pct = Math.round(day.rainChancePct);

  if (!condicao && day.maxC === null && day.minC === null && day.rainChancePct === null) {
    return { success: false, error: 'não consegui consultar a previsão agora' };
  }

  return result;
}
