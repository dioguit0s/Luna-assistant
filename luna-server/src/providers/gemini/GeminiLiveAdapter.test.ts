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
  audioPacingLeadMs: 250,
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
  ringListenWindowMs: 6_000,
  ringBargeInGuardMs: 2_000,
  ringSilentRetryMs: 60_000,
  ringMaxDeferMs: 3_000,
  reminderSnoozeMaxMinutes: 60,
  weatherLatitude: null,
  weatherLongitude: null,
  weatherTtlMs: 600_000,
  weatherMaxStaleMs: 10_800_000,
};

const SESSION_CONFIG: ProviderSessionConfig = {
  roomId: 'sala_de_estar',
  systemPrompt: 'x',
  history: [],
  tools: [],
  refreshSystemPrompt: () => 'x',
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
  systemInstruction: unknown;
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
      connect: (params: {
        callbacks: LiveCallbacks;
        config?: { systemInstruction?: unknown };
      }): Promise<FakeSession> => {
        const session: FakeSession = {
          closed: false,
          close: () => {
            session.closed = true;
          },
          sendRealtimeInput: () => {},
          sendToolResponse: () => {},
        };
        calls.push({
          session,
          callbacks: params.callbacks,
          systemInstruction: params.config?.systemInstruction,
        });
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

describe('GeminiLiveAdapter: renovação de sessão pega hora atual', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('renewSession chama refreshSystemPrompt em vez de reusar o texto do connect original', async () => {
    const { client, calls } = buildFakeClient();
    let promptCalls = 0;
    const sessionConfig: ProviderSessionConfig = {
      ...SESSION_CONFIG,
      systemPrompt: 'Agora são 07:00',
      refreshSystemPrompt: () => {
        promptCalls += 1;
        return `Agora são 07:0${promptCalls}`;
      },
    };

    const adapter = new GeminiLiveAdapter(baseConfig, () => client);
    await adapter.connect(sessionConfig);

    assert.equal(calls[0]!.systemInstruction, 'Agora são 07:00', 'connect inicial usa o prompt já pronto');
    assert.equal(promptCalls, 0, 'connect inicial não deveria chamar refreshSystemPrompt');

    adapter.sendAudio(Buffer.alloc(4));
    calls[0]!.callbacks.onmessage({ goAway: { timeLeft: '5s' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 2, 'renewSession deveria ter aberto uma segunda sessão');
    assert.equal(promptCalls, 1, 'renewSession deveria ter pedido um prompt novo');
    assert.equal(
      calls[1]!.systemInstruction,
      'Agora são 07:01',
      'a sessão renovada deveria usar o prompt refeito, não o congelado do connect original',
    );
  });
});

describe('GeminiLiveAdapter: áudio em voo durante renewSession', () => {
  before(() => {
    createLogger(baseConfig);
  });

  /** Buffer PCM16 24kHz não-vazio, só para exercitar o resampler de verdade. */
  function fakeAudioChunk(samples = 480): string {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      buf.writeInt16LE(Math.round(5000 * Math.sin(i / 10)), i * 2);
    }
    return buf.toString('base64');
  }

  /**
   * Regressão: uma correção anterior bloqueava QUALQUER `onmessage` da sessão
   * antiga assim que `renewSession` completava (guarda de `sessionGeneration`
   * também em `onmessage`, não só em `onclose`). Isso "consertava" a
   * descontinuidade de fase do resampler jogando fora um problema muito
   * pior: `renewSession` fecha a sessão antiga só DEPOIS de abrir a nova, e
   * nesse intervalo ela pode entregar o RESTO de uma resposta genuína já em
   * voo — bloquear a mensagem faz essa cauda de áudio (e, em produção, uma
   * resposta inteira observada sumindo assim) desaparecer sem nenhum sinal.
   * A correção certa é um resampler por sessão (ver `openLiveSession`), não
   * bloquear a entrega.
   */
  it('áudio que chega pela sessão ANTIGA depois da renovação completar ainda é entregue', async () => {
    const { client, calls } = buildFakeClient();
    const delivered: Buffer[] = [];

    const adapter = new GeminiLiveAdapter(baseConfig, () => client);
    adapter.onAudioResponse((chunk) => delivered.push(chunk));

    await adapter.connect(SESSION_CONFIG);
    adapter.sendAudio(Buffer.alloc(4));

    // Uma resposta já começou a chegar pela sessão 1 antes do goAway — é
    // exatamente o caso real: o goAway pega uma resposta em andamento.
    calls[0]!.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: fakeAudioChunk() } }] } },
    });
    assert.equal(delivered.length, 1, 'primeiro chunk da sessão 1 deveria ter sido entregue');

    // goAway -> renewSession abre a sessão 2 e fecha a sessão 1.
    calls[0]!.callbacks.onmessage({ goAway: { timeLeft: '5s' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2, 'renewSession deveria ter aberto a sessão 2');
    assert.equal(calls[0]!.session.closed, true, 'sessão 1 deveria estar marcada como fechada');

    // O resto da MESMA resposta ainda chega pela sessão 1 (closed=true é só
    // o nosso lado tendo pedido o fechamento — o evento já estava em voo).
    calls[0]!.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: fakeAudioChunk() } }] } },
    });
    assert.equal(
      delivered.length,
      2,
      'áudio da sessão antiga chegado DEPOIS da renovação não pode ser descartado — é a cauda de uma resposta real',
    );

    // E a sessão 2 (a atual) entrega normalmente também — as duas convivem
    // sem uma bloquear a outra.
    calls[1]!.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: fakeAudioChunk() } }] } },
    });
    assert.equal(delivered.length, 3);

    for (const chunk of delivered) {
      assert.ok(chunk.length > 0, 'todo chunk entregue deve ter conteúdo (resampler não pode zerar a saída)');
    }
  });
});
