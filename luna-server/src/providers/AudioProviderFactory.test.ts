import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioProvider } from './AudioProviderFactory.js';
import type { AppConfig } from '../config/env.js';

describe('AudioProviderFactory', () => {
  const baseConfig: AppConfig = {
    audioProvider: 'gemini',
    geminiApiKey: 'test-key',
    openaiApiKey: 'test-key',
    wsAuthSecret: 'secret',
    wsPort: 8080,
    logLevel: 'info',
    geminiLiveModel: 'gemini-test',
    openaiRealtimeModel: 'gpt-test',
    haUrl: '',
    haToken: '',
    geminiVadSilenceMs: null,
    geminiVadEndSensitivity: null,
    geminiManualActivity: false,
    geminiDebugMessages: false,
  };

  it('instancia GeminiLiveAdapter', () => {
    const provider = createAudioProvider({ ...baseConfig, audioProvider: 'gemini' });
    assert.equal(provider.constructor.name, 'GeminiLiveAdapter');
  });

  it('instancia OpenAIRealtimeAdapter', () => {
    const provider = createAudioProvider({ ...baseConfig, audioProvider: 'openai' });
    assert.equal(provider.constructor.name, 'OpenAIRealtimeAdapter');
  });
});
