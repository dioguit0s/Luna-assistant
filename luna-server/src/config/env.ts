import { config as loadEnv } from 'dotenv';

loadEnv();

export type AudioProviderName = 'gemini' | 'openai';

export interface AppConfig {
  audioProvider: AudioProviderName;
  geminiApiKey: string;
  openaiApiKey: string;
  wsAuthSecret: string;
  wsPort: number;
  logLevel: string;
  geminiLiveModel: string;
  openaiRealtimeModel: string;
  haUrl: string;
  haToken: string;
  geminiVadSilenceMs: number | null;
  geminiVadEndSensitivity: EndSensitivityName | null;
  geminiManualActivity: boolean;
  /** Loga mensagens cruas do Gemini, incluindo transcrições da fala do usuário. */
  geminiDebugMessages: boolean;
}

export type EndSensitivityName = 'HIGH' | 'LOW';

function parseEndSensitivity(value: string | undefined): EndSensitivityName | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === 'HIGH' || upper === 'LOW') return upper;
  throw new Error(`GEMINI_VAD_END_SENSITIVITY inválido: "${value}". Use "HIGH" ou "LOW".`);
}

function parseOptionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} inválido: "${raw}". Use um número de milissegundos.`);
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function parseAudioProvider(value: string): AudioProviderName {
  if (value === 'gemini' || value === 'openai') {
    return value;
  }
  throw new Error(`AUDIO_PROVIDER inválido: "${value}". Use "gemini" ou "openai".`);
}

export function loadConfig(): AppConfig {
  const audioProvider = parseAudioProvider(process.env.AUDIO_PROVIDER ?? 'gemini');

  const config: AppConfig = {
    audioProvider,
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    wsAuthSecret: requireEnv('WS_AUTH_SECRET'),
    wsPort: Number(process.env.WS_PORT ?? 8080),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    geminiLiveModel:
      process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.5-flash-native-audio-preview-12-2025',
    openaiRealtimeModel:
      process.env.OPENAI_REALTIME_MODEL ?? 'gpt-4o-realtime-preview-2024-12-17',
    haUrl: process.env.HA_URL ?? '',
    haToken: process.env.HA_TOKEN ?? '',
    geminiVadSilenceMs: parseOptionalNumber('GEMINI_VAD_SILENCE_MS'),
    geminiVadEndSensitivity: parseEndSensitivity(process.env.GEMINI_VAD_END_SENSITIVITY),
    geminiManualActivity: process.env.GEMINI_MANUAL_ACTIVITY === 'true',
    geminiDebugMessages: process.env.GEMINI_DEBUG_MESSAGES === 'true',
  };

  if (audioProvider === 'gemini' && !config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY é obrigatória quando AUDIO_PROVIDER=gemini');
  }
  if (audioProvider === 'openai' && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY é obrigatória quando AUDIO_PROVIDER=openai');
  }

  return config;
}
