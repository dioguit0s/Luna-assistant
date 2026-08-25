/**
 * Códigos de condição do tempo do WMO (usados pelo Open-Meteo em `weather_code`),
 * traduzidos para um texto falável em português.
 *
 * Código fora do mapa devolve `null`, nunca um texto genérico como "tempo
 * instável": um fallback inventado faria a Luna afirmar uma condição que
 * ninguém verificou. Melhor ela dizer só a temperatura.
 *
 * `is_day` não entra na escolha do texto: os rótulos abaixo valem de dia e de
 * noite ("céu limpo" às 22h está certo; um texto como "ensolarado" não estaria).
 */
const WMO_CONDITION_PT: Record<number, string> = {
  0: 'céu limpo',
  1: 'poucas nuvens',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'névoa',
  48: 'névoa com geada',
  51: 'garoa fraca',
  53: 'garoa',
  55: 'garoa forte',
  56: 'garoa congelante fraca',
  57: 'garoa congelante',
  61: 'chuva fraca',
  63: 'chuva',
  65: 'chuva forte',
  66: 'chuva congelante fraca',
  67: 'chuva congelante',
  71: 'neve fraca',
  73: 'neve',
  75: 'neve forte',
  77: 'grãos de neve',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva',
  82: 'pancadas de chuva fortes',
  85: 'pancadas de neve fracas',
  86: 'pancadas de neve fortes',
  95: 'tempestade',
  96: 'tempestade com granizo',
  99: 'tempestade com granizo forte',
};

/** Traduz um `weather_code` do WMO para texto falável. `null` se desconhecido. */
export function describeWeatherCode(code: unknown): string | null {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;
  return WMO_CONDITION_PT[code] ?? null;
}
