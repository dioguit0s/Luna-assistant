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
  };

  if (audioProvider === 'gemini' && !config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY é obrigatória quando AUDIO_PROVIDER=gemini');
  }
  if (audioProvider === 'openai' && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY é obrigatória quando AUDIO_PROVIDER=openai');
  }

  return config;
}
