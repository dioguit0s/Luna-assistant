import type { AppConfig, AudioProviderName } from '../config/env.js';
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
}

export type GroupName = keyof SettingsGroups;

export const GROUP_NAMES: readonly GroupName[] = [
  'ha',
  'provider',
  'calendar',
  'devices',
  'rooms',
  'satellites',
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
  };
}

/**
 * Variáveis do `.env` que semeiam um campo de runtime. Depois da semeadura, uma
 * delas **presente** no ambiente com valor diferente do banco gera o aviso
 * `config_env_ignored` — ausente não, senão todo campo com default avisaria.
 */
export const ENV_SEEDS: ReadonlyArray<{ group: 'ha' | 'provider' | 'calendar'; field: string; env: string }> = [
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
