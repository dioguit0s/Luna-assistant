import type { AppConfig, AudioProviderName, EndSensitivityName, OpenAIVadType } from '../config/env.js';
import {
  serializeDeviceOverrides,
  validateDeviceOverrides,
  type DeviceOverrides,
} from '../ha/deviceRegistrySource.js';

/**
 * Grupos de configuração de **runtime** (ADR 010, decisão 3): o que o painel
 * edita e que vive no SQLite. O grupo de bootstrap (porta, segredo WS, token
 * admin, caminho do banco, nível de log) continua no `.env` e não aparece aqui.
 */
export interface HaSettings {
  url: string;
  token: string;
}

export interface ProviderSettings {
  provider: AudioProviderName;
  geminiApiKey: string;
  openaiApiKey: string;
  geminiLiveModel: string;
  openaiRealtimeModel: string;
  openaiVoice: string;
}

/**
 * Ajuste fino da conversa (v2, "Provedor de IA — avançado"): os botões de
 * latência que antes só o `.env` mexia. Vale na próxima sessão do provider,
 * exceto `userSilenceCutoffMs`, que o `Orchestrator` lê a cada turno.
 */
export interface VoiceSettings {
  /** `null` = deixa o default do Gemini. */
  geminiVadSilenceMs: number | null;
  geminiVadEndSensitivity: EndSensitivityName | null;
  /** `-1` automático, `0` desligado, `null` omite o campo. */
  geminiThinkingBudget: number | null;
  openaiVadType: OpenAIVadType;
  openaiVadSilenceMs: number | null;
  userSilenceCutoffMs: number;
}

/**
 * Localização da casa para a previsão (v2). Coordenadas `null` desligam a tool
 * `get_weather`. `city` é só rótulo: quem manda são as coordenadas, que o
 * painel obtém por geocoding e o operador confirma.
 */
export interface WeatherSettings {
  city: string;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Conexão com o app de agendas. Só a conexão: as tools dependem do TODO da API
 * do app (ver `docs/painel-de-controle.md`).
 */
export interface CalendarSettings {
  url: string;
  token: string;
}

export interface RoomsSettings {
  /** `room_id` da Luna → `area_id` do HA. */
  areas: Record<string, string>;
}

export interface SatellitesSettings {
  /** `device_id` → nome amigável. */
  names: Record<string, string>;
}

export interface SettingsGroups {
  ha: HaSettings;
  provider: ProviderSettings;
  calendar: CalendarSettings;
  devices: DeviceOverrides;
  rooms: RoomsSettings;
  satellites: SatellitesSettings;
  voice: VoiceSettings;
  weather: WeatherSettings;
}

export type GroupName = keyof SettingsGroups;

export const GROUP_NAMES: readonly GroupName[] = [
  'ha',
  'provider',
  'calendar',
  'devices',
  'rooms',
  'satellites',
  'voice',
  'weather',
];

/** Erro de validação com o campo culpado — vira o 422 da API admin. */
export class SettingsValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Mesmo formato do `room_id` aceito no auth do WS e do `area_id` do HA. */
export const ROOM_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

const MAX_TEXT = 200;
const MAX_SECRET = 4096;

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsValidationError(field, `"${field}" deve ser um objeto.`);
  }
  return value as Record<string, unknown>;
}

/** `undefined` = campo ausente do patch = mantém o valor atual. */
function text(
  patch: Record<string, unknown>,
  field: string,
  current: string,
  opts: { required?: boolean; max?: number } = {},
): string {
  const raw = patch[field];
  if (raw === undefined) return current;
  if (typeof raw !== 'string') {
    throw new SettingsValidationError(field, `"${field}" deve ser texto.`);
  }
  const value = raw.trim();
  if (opts.required && value.length === 0) {
    throw new SettingsValidationError(field, `"${field}" não pode ficar vazio.`);
  }
  if (value.length > (opts.max ?? MAX_TEXT)) {
    throw new SettingsValidationError(field, `"${field}" é longo demais.`);
  }
  return value;
}

/** Número opcional numa faixa; `null` explícito é permitido quando `nullable`. */
function num(
  patch: Record<string, unknown>,
  field: string,
  current: number | null,
  opts: { min: number; max: number; integer?: boolean; nullable?: boolean },
): number | null {
  const raw = patch[field];
  if (raw === undefined) return current;
  if (raw === null) {
    if (opts.nullable) return null;
    throw new SettingsValidationError(field, `"${field}" é obrigatório.`);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || (opts.integer && !Number.isInteger(raw))) {
    throw new SettingsValidationError(field, `"${field}" deve ser ${opts.integer ? 'inteiro' : 'número'}.`);
  }
  if (raw < opts.min || raw > opts.max) {
    throw new SettingsValidationError(field, `"${field}" deve ficar entre ${opts.min} e ${opts.max}.`);
  }
  return raw;
}

function oneOf<T extends string>(
  patch: Record<string, unknown>,
  field: string,
  current: T | null,
  values: readonly T[],
  nullable: boolean,
): T | null {
  const raw = patch[field];
  if (raw === undefined) return current;
  if (raw === null && nullable) return null;
  if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
    throw new SettingsValidationError(field, `"${field}" deve ser ${values.join(' ou ')}.`);
  }
  return raw as T;
}

/** Vazio é permitido (integração desligada); preenchido tem que ser http(s). */
function httpUrl(patch: Record<string, unknown>, field: string, current: string): string {
  const value = text(patch, field, current);
  if (value === '') return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SettingsValidationError(field, `"${field}" não é uma URL válida.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsValidationError(field, `"${field}" deve começar com http:// ou https://.`);
  }
  return value.replace(/\/+$/, '');
}

function stringMap(
  value: unknown,
  field: string,
  keyCheck: (key: string) => boolean,
  valueCheck: (value: string) => boolean,
  hint: string,
): Record<string, string> {
  const obj = asObject(value, field);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (!keyCheck(key) || typeof raw !== 'string' || !valueCheck(raw.trim())) {
      throw new SettingsValidationError(field, `"${field}.${key}" inválido: ${hint}`);
    }
    out[key] = raw.trim();
  }
  return out;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * URL + token de uma integração. Trocar a **origem** da URL exige o token no
 * mesmo patch: o token gravado segue a URL, e o HA reconfigurado a quente o
 * mandaria na hora para o host novo — quem tivesse o token admin extrairia o
 * `HA_TOKEN` com um `PUT` (ADR 010, decisão 4).
 */
function connectionGroup(
  current: { url: string; token: string },
  patch: Record<string, unknown>,
): { url: string; token: string } {
  const url = httpUrl(patch, 'url', current.url);
  const token = text(patch, 'token', current.token, { max: MAX_SECRET });
  const before = originOf(current.url);
  if (patch.token === undefined && current.token && before && originOf(url) !== before) {
    throw new SettingsValidationError('token', 'Digite o token de novo para trocar de servidor.');
  }
  return { url, token };
}

type Validator<G extends GroupName> = (
  current: SettingsGroups[G],
  patch: unknown,
) => SettingsGroups[G];

/**
 * Um validador por grupo, aplicado ao patch sobre o valor atual. Lança
 * `SettingsValidationError`; o banco nunca recebe configuração inválida.
 */
export const VALIDATORS: { [G in GroupName]: Validator<G> } = {
  ha: (current, raw) => connectionGroup(current, asObject(raw, 'ha')),

  provider: (current, raw) => {
    const patch = asObject(raw, 'provider');
    const provider = patch.provider === undefined ? current.provider : patch.provider;
    if (provider !== 'gemini' && provider !== 'openai') {
      throw new SettingsValidationError('provider', 'Use "gemini" ou "openai".');
    }
    const next: ProviderSettings = {
      provider,
      geminiApiKey: text(patch, 'geminiApiKey', current.geminiApiKey, { max: MAX_SECRET }),
      openaiApiKey: text(patch, 'openaiApiKey', current.openaiApiKey, { max: MAX_SECRET }),
      geminiLiveModel: text(patch, 'geminiLiveModel', current.geminiLiveModel, { required: true }),
      openaiRealtimeModel: text(patch, 'openaiRealtimeModel', current.openaiRealtimeModel, {
        required: true,
      }),
      openaiVoice: text(patch, 'openaiVoice', current.openaiVoice, { required: true }),
    };
    assertProviderUsable(next);
    return next;
  },

  calendar: (current, raw) => connectionGroup(current, asObject(raw, 'calendar')),

  devices: (current, raw) => {
    const patch = asObject(raw, 'devices');
    const merged = { ...serializeDeviceOverrides(current), ...patch };
    try {
      return validateDeviceOverrides(merged, 'devices');
    } catch (err) {
      throw new SettingsValidationError(
        'devices',
        err instanceof Error ? err.message : 'overrides inválidos',
      );
    }
  },

  rooms: (current, raw) => {
    const patch = asObject(raw, 'rooms');
    if (patch.areas === undefined) return current;
    return {
      areas: stringMap(
        patch.areas,
        'areas',
        (key) => ROOM_ID_PATTERN.test(key),
        (value) => ROOM_ID_PATTERN.test(value),
        'sala e área usam minúsculas, dígitos e _',
      ),
    };
  },

  // Faixas **iguais** às do `loadConfig` (`parseOptionalNumber`,
  // `parseThinkingBudget`): o grupo nasce da semente do `.env`, e um valor que
  // o `.env` aceitava e o validador recusasse derrubaria o primeiro boot desta
  // versão num banco que já existe. Apertar aqui é apertar lá também.
  voice: (current, raw) => {
    const patch = asObject(raw, 'voice');
    const ms = { min: 0, max: Number.MAX_SAFE_INTEGER };
    return {
      geminiVadSilenceMs: num(patch, 'geminiVadSilenceMs', current.geminiVadSilenceMs, { ...ms, nullable: true }),
      geminiVadEndSensitivity: oneOf(patch, 'geminiVadEndSensitivity', current.geminiVadEndSensitivity, ['HIGH', 'LOW'] as const, true),
      geminiThinkingBudget: num(patch, 'geminiThinkingBudget', current.geminiThinkingBudget, { min: -1, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true }),
      openaiVadType: oneOf(patch, 'openaiVadType', current.openaiVadType, ['server_vad', 'semantic_vad'] as const, false)!,
      openaiVadSilenceMs: num(patch, 'openaiVadSilenceMs', current.openaiVadSilenceMs, { ...ms, nullable: true }),
      userSilenceCutoffMs: num(patch, 'userSilenceCutoffMs', current.userSilenceCutoffMs, ms)!,
    };
  },

  weather: (current, raw) => {
    const patch = asObject(raw, 'weather');
    const latitude = num(patch, 'latitude', current.latitude, { min: -90, max: 90, nullable: true });
    const longitude = num(patch, 'longitude', current.longitude, { min: -180, max: 180, nullable: true });
    // Mesma regra do `loadConfig`: meia coordenada é previsão do lugar errado.
    if ((latitude === null) !== (longitude === null)) {
      throw new SettingsValidationError(latitude === null ? 'latitude' : 'longitude', 'Latitude e longitude vão juntas.');
    }
    const city = text(patch, 'city', current.city, { max: 120 });
    return { city: latitude === null ? '' : city, latitude, longitude };
  },

  satellites: (current, raw) => {
    const patch = asObject(raw, 'satellites');
    if (patch.names === undefined) return current;
    return {
      names: stringMap(
        patch.names,
        'names',
        (key) => key.length > 0 && key.length <= 128,
        (value) => value.length > 0 && value.length <= 64,
        'nome de 1 a 64 caracteres',
      ),
    };
  },
};

/**
 * Mesma regra que o `loadConfig` aplicava ao `.env`: sem a chave do provider
 * escolhido, nenhuma sala abre sessão.
 */
export function assertProviderUsable(settings: ProviderSettings): void {
  if (settings.provider === 'gemini' && !settings.geminiApiKey) {
    throw new SettingsValidationError('geminiApiKey', 'GEMINI_API_KEY é obrigatória com o Gemini.');
  }
  if (settings.provider === 'openai' && !settings.openaiApiKey) {
    throw new SettingsValidationError('openaiApiKey', 'OPENAI_API_KEY é obrigatória com a OpenAI.');
  }
}

/** Valores de semente: o que o `.env` (já parseado) e o `devices.json` dizem hoje. */
export function seedFromConfig(
  base: AppConfig,
  devices: DeviceOverrides,
  env: NodeJS.ProcessEnv,
): SettingsGroups {
  return {
    ha: { url: base.haUrl.replace(/\/+$/, ''), token: base.haToken },
    provider: {
      provider: base.audioProvider,
      geminiApiKey: base.geminiApiKey,
      openaiApiKey: base.openaiApiKey,
      geminiLiveModel: base.geminiLiveModel,
      openaiRealtimeModel: base.openaiRealtimeModel,
      openaiVoice: base.openaiVoice,
    },
    calendar: { url: env.CALENDAR_URL?.trim() ?? '', token: env.CALENDAR_TOKEN?.trim() ?? '' },
    devices,
    rooms: { areas: {} },
    satellites: { names: {} },
    voice: {
      geminiVadSilenceMs: base.geminiVadSilenceMs,
      geminiVadEndSensitivity: base.geminiVadEndSensitivity,
      geminiThinkingBudget: base.geminiThinkingBudget,
      openaiVadType: base.openaiVadType,
      openaiVadSilenceMs: base.openaiVadSilenceMs,
      userSilenceCutoffMs: base.userSilenceCutoffMs,
    },
    weather: {
      city: env.WEATHER_CITY?.trim() ?? '',
      latitude: base.weatherLatitude,
      longitude: base.weatherLongitude,
    },
  };
}

/**
 * Variáveis do `.env` que semeiam um campo de runtime. Depois da semeadura, uma
 * delas **presente** no ambiente com valor diferente do banco gera o aviso
 * `config_env_ignored` — ausente não, senão todo campo com default avisaria.
 */
export const ENV_SEEDS: ReadonlyArray<{ group: 'ha' | 'provider' | 'calendar' | 'voice' | 'weather'; field: string; env: string }> = [
  { group: 'ha', field: 'url', env: 'HA_URL' },
  { group: 'ha', field: 'token', env: 'HA_TOKEN' },
  { group: 'provider', field: 'provider', env: 'AUDIO_PROVIDER' },
  { group: 'provider', field: 'geminiApiKey', env: 'GEMINI_API_KEY' },
  { group: 'provider', field: 'openaiApiKey', env: 'OPENAI_API_KEY' },
  { group: 'provider', field: 'geminiLiveModel', env: 'GEMINI_LIVE_MODEL' },
  { group: 'provider', field: 'openaiRealtimeModel', env: 'OPENAI_REALTIME_MODEL' },
  { group: 'provider', field: 'openaiVoice', env: 'OPENAI_VOICE' },
  { group: 'calendar', field: 'url', env: 'CALENDAR_URL' },
  { group: 'calendar', field: 'token', env: 'CALENDAR_TOKEN' },
  { group: 'voice', field: 'geminiVadSilenceMs', env: 'GEMINI_VAD_SILENCE_MS' },
  { group: 'voice', field: 'geminiVadEndSensitivity', env: 'GEMINI_VAD_END_SENSITIVITY' },
  { group: 'voice', field: 'geminiThinkingBudget', env: 'GEMINI_THINKING_BUDGET' },
  { group: 'voice', field: 'openaiVadType', env: 'OPENAI_VAD_TYPE' },
  { group: 'voice', field: 'openaiVadSilenceMs', env: 'OPENAI_VAD_SILENCE_MS' },
  { group: 'voice', field: 'userSilenceCutoffMs', env: 'USER_SILENCE_CUTOFF_MS' },
  { group: 'weather', field: 'latitude', env: 'WEATHER_LATITUDE' },
  { group: 'weather', field: 'longitude', env: 'WEATHER_LONGITUDE' },
];

/** Campos que a API admin nunca devolve (ADR 010, decisão 4). */
export const SECRET_FIELDS: { [G in GroupName]?: readonly string[] } = {
  ha: ['token'],
  provider: ['geminiApiKey', 'openaiApiKey'],
  calendar: ['token'],
};

export interface MaskedSecret {
  set: boolean;
  /** Últimos 4 caracteres, só quando o segredo é longo o bastante para isso não entregá-lo. */
  last4: string | null;
}

export function maskSecret(value: string): MaskedSecret {
  if (!value) return { set: false, last4: null };
  return { set: true, last4: value.length >= 12 ? value.slice(-4) : null };
}

/** O grupo com cada segredo trocado pela máscara. */
export function maskGroup<G extends GroupName>(group: G, value: SettingsGroups[G]): unknown {
  const secrets = SECRET_FIELDS[group];
  if (!secrets) return value;
  const out: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  for (const field of secrets) {
    out[field] = maskSecret(String(out[field] ?? ''));
  }
  return out;
}

/** Forma persistida: `devices` vai no formato de arquivo, o resto como está. */
export function toStored<G extends GroupName>(group: G, value: SettingsGroups[G]): unknown {
  return group === 'devices' ? serializeDeviceOverrides(value as DeviceOverrides) : value;
}
