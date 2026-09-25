/**
 * Cidade → coordenadas, para o "Clima" do painel (v2). Geocoding do próprio
 * Open-Meteo: mesmo provedor da previsão, sem chave. Só o painel usa; a tool
 * `get_weather` continua lendo as coordenadas gravadas, nunca geocodifica.
 *
 * Nunca lança, como `OpenMeteoClient`: devolve `null` em falha de rede ou
 * resposta malformada.
 */

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 5000;
const MAX_RESULTS = 5;

export interface GeocodeCandidate {
  /** "São Paulo, São Paulo, Brasil" — o que o painel mostra e grava como `city`. */
  label: string;
  latitude: number;
  longitude: number;
}

export async function geocodeCity(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodeCandidate[] | null> {
  const params = new URLSearchParams({
    name,
    count: String(MAX_RESULTS),
    language: 'pt',
    format: 'json',
  });
  try {
    const res = await fetchImpl(`${GEOCODING_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { results?: unknown } | null;
    if (!body) return null;
    // Sem `results` é "não achei", não falha.
    if (!Array.isArray(body.results)) return [];
    const out: GeocodeCandidate[] = [];
    for (const r of body.results as Array<Record<string, unknown>>) {
      if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number' || typeof r.name !== 'string') continue;
      const parts = [r.name, r.admin1, r.country].filter((p): p is string => typeof p === 'string' && p.length > 0);
      out.push({ label: [...new Set(parts)].join(', ').slice(0, 120), latitude: r.latitude, longitude: r.longitude });
    }
    return out;
  } catch {
    return null;
  }
}
