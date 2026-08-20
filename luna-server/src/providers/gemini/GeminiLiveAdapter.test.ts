import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { GeminiLiveAdapter } from './GeminiLiveAdapter.js';
import type { ProviderSessionConfig } from '../types.js';

const baseConfig: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'test-key',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0,
  logLevel: 'silent',
  geminiLiveModel: 'test-model',
  openaiRealtimeModel: 'test-model',
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
};

const SESSION_CONFIG: ProviderSessionConfig = {
  roomId: 'sala_de_estar',
  systemPrompt: 'x',
  history: [],
  tools: [],
};

interface LiveCallbacks {
  onmessage: (message: unknown) => void;
  onerror?: (e: unknown) => void;
  onclose?: () => void;
}

interface FakeSession {
  closed: boolean;
  close: () => void;
  sendRealtimeInput: (input: unknown) => void;
  sendToolResponse: (input: unknown) => void;
}

interface CapturedConnectCall {
  session: FakeSession;
  callbacks: LiveCallbacks;
}

/**
 * Fake mínimo de `GoogleGenAI`: só implementa `live.connect`, o único ponto
 * que o adapter usa. Cada chamada cria uma sessão fake distinta e captura os
 * `callbacks` passados, para o teste poder disparar `onclose`/`onmessage`
 * manualmente e simular o `onclose` tardio de uma sessão já substituída.
 */
function buildFakeClient(): { client: GoogleGenAI; calls: CapturedConnectCall[] } {
  const calls: CapturedConnectCall[] = [];

  const client = {
    live: {
      connect: (params: { callbacks: LiveCallbacks }): Promise<FakeSession> => {
        const session: FakeSession = {
          closed: false,
          close: () => {
            session.closed = true;
          },
          sendRealtimeInput: () => {},
          sendToolResponse: () => {},
        };
        calls.push({ session, callbacks: params.callbacks });
        return Promise.resolve(session);
      },
    },
  };

  return { client: client as unknown as GoogleGenAI, calls };
}

describe('GeminiLiveAdapter: guarda de sessionGeneration', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('onclose tardio de uma sessão renovada e já substituída não apaga a sessão nova', async () => {
    const { client, calls } = buildFakeClient();
    let sessionEndedCount = 0;

    const adapter = new GeminiLiveAdapter(baseConfig, () => client);
    adapter.onSessionEnded(() => {
      sessionEndedCount += 1;
    });

    await adapter.connect(SESSION_CONFIG);
    assert.equal(calls.length, 1);

    // Fala recente: handleGoAway escolhe renovar (janela de conversa ativa),
    // não deixar expirar.
    adapter.sendAudio(Buffer.alloc(4));

    // goAway chega na sessão 1 -> handleGoAway -> renewSession (fire-and-forget).
    calls[0]!.callbacks.onmessage({ goAway: { timeLeft: '5s' } });

    // renewSession é assíncrono (await no live.connect da renovação, que aqui
    // resolve no microtask seguinte) — dá uma volta no event loop para
    // assentar antes de inspecionar o resultado.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 2, 'renewSession deveria ter aberto uma segunda sessão');
    assert.equal(
      calls[0]!.session.closed,
      true,
      'sessão antiga deveria ter sido fechada explicitamente após a renovação',
    );
    assert.equal(sessionEndedCount, 0, 'renovação bem-sucedida não deve notificar sessionEndedCb');

    // O evento real que este guard existe para cobrir: o SDK notifica o
    // `onclose` da sessão ANTIGA só depois, quando `this.session` já foi
    // trocado pela sessão nova dentro de `renewSession`.
    calls[0]!.callbacks.onclose?.();

    assert.equal(
      sessionEndedCount,
      0,
      'onclose tardio da sessão antiga (generation desatualizada) não pode disparar sessionEndedCb',
    );

    // A sessão atual (a nova) continua íntegra: sendAudio não deveria achar
    // "sem sessão" nem disparar sessionEndedCb por engano.
    adapter.sendAudio(Buffer.alloc(4));
    assert.equal(sessionEndedCount, 0);

    // E o onclose genuíno da sessão atual continua funcionando normalmente.
    calls[1]!.callbacks.onclose?.();
    assert.equal(sessionEndedCount, 1);
  });

  it('onclose da única sessão (sem renovação) dispara sessionEndedCb normalmente', async () => {
    const { client, calls } = buildFakeClient();
    let sessionEndedCount = 0;

    const adapter = new GeminiLiveAdapter(baseConfig, () => client);
    adapter.onSessionEnded(() => {
      sessionEndedCount += 1;
    });

    await adapter.connect(SESSION_CONFIG);
    assert.equal(calls.length, 1);

    calls[0]!.callbacks.onclose?.();

    assert.equal(sessionEndedCount, 1);

    // Idempotente: um segundo onclose da mesma sessão (não deveria acontecer
    // de verdade, mas é a mesma guarda que cobre o resto do arquivo) não
    // dispara de novo.
    calls[0]!.callbacks.onclose?.();
    assert.equal(sessionEndedCount, 1);
  });
});
