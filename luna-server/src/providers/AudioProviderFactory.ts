import type { AppConfig } from '../config/env.js';
import type { IAudioProvider } from './IAudioProvider.js';
import { GeminiLiveAdapter } from './gemini/GeminiLiveAdapter.js';
import { OpenAIRealtimeAdapter } from './openai/OpenAIRealtimeAdapter.js';

export function createAudioProvider(config: AppConfig): IAudioProvider {
  switch (config.audioProvider) {
    case 'gemini':
      return new GeminiLiveAdapter(config);
    case 'openai':
      return new OpenAIRealtimeAdapter(config);
    default: {
      const _exhaustive: never = config.audioProvider;
      throw new Error(`Provider não suportado: ${_exhaustive}`);
    }
  }
}

export function getActiveProviderName(config: AppConfig): string {
  return config.audioProvider;
}
