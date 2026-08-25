/**
 * Smoke test manual do Open-Meteo real.
 *
 *   node --import tsx scripts/weather-smoke.ts
 *
 * Precisa de WEATHER_LATITUDE/WEATHER_LONGITUDE no .env. A rede de
 * desenvolvimento deste repositório é bloqueada para api.open-meteo.com — é
 * este script, rodado na máquina de quem está implementando, que confirma os
 * nomes de variável e o shape da resposta contra a API de verdade (ver
 * docs/adr/008-tempo-e-previsao.md).
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/logging/logger.js';
import { OpenMeteoClient } from '../src/weather/OpenMeteoClient.js';

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

  if (config.weatherLatitude === null || config.weatherLongitude === null) {
    console.error('WEATHER_LATITUDE/WEATHER_LONGITUDE ausentes no .env.');
    process.exit(1);
  }

  console.log(`Open-Meteo: latitude=${config.weatherLatitude} longitude=${config.weatherLongitude}\n`);

  const client = new OpenMeteoClient(config.weatherLatitude, config.weatherLongitude);
  const snapshot = await client.fetchForecast();

  console.log('snapshot parseado:', JSON.stringify(snapshot, null, 2));

  if (snapshot === null) {
    console.error('\nfetchForecast() devolveu null — ver o log acima para o motivo.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Falha no smoke test do Open-Meteo:', err);
  process.exit(1);
});
