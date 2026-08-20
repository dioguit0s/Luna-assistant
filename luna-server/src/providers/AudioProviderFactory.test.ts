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
    devicesConfigPath: 'config/devices.json',
    deviceRegistryTtlMs: 300_000,
    providerConnectTimeoutMs: 5000,
    geminiVadSilenceMs: null,
    geminiVadEndSensitivity: null,
    geminiManualActivity: false,
    geminiThinkingBudget: 0,
    geminiDebugMessages: false,
    userSilenceCutoffMs: 500,
    openaiVadType: 'server_vad',
    openaiVadSilenceMs: null,
    openaiDebugMessages: false,
    openaiVoice: 'marin',
    dbPath: ':memory:',
  missedGraceMs: 15 * 60_000,
  alarmMaxRingMs: 5 * 60_000,
  reminderMaxConcurrent: 20,
  reminderMaxPerRoom: 20,
  reminderFallbackRoomId: '',
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
