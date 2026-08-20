import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from './ConversationRingBuffer.js';
import { RoomManager } from './RoomManager.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../providers/types.js';

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
  providerConnectTimeoutMs: 50,
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
};

/**
 * Provider cujo `connect()` fica pendurado até `resolveConnect()`/`rejectConnect()`
 * ser chamado explicitamente — simula o blackhole de rede que o timeout de
 * `RoomManager.awaitConnectWithTimeout` existe para cobrir.
 */
class ControllableProvider implements IAudioProvider {
  disconnectCalls = 0;
  private resolveFn: (() => void) | null = null;
  private rejectFn: ((err: Error) => void) | null = null;

  connect(_session: ProviderSessionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolveConnect(): void {
    this.resolveFn?.();
  }

  rejectConnect(err: Error): void {
    this.rejectFn?.(err);
  }

  sendAudio(_pcm16kHz: Buffer): void {}
  signalActivityEnd(): void {}
  onAudioResponse(_callback: (chunk: Buffer) => void): void {}
  onUserSpeech(_callback: () => void): void {}
  onTurnComplete(_callback: (turn: CompletedTurn) => void): void {}
  onError(_callback: (err: Error) => void): void {}
  onSessionEnded(_callback: () => void): void {}
  onToolCall(_callback: (call: ToolCall) => void): void {}
  sendToolResult(_callId: string, _result: unknown): void {}

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

/** Provider cujo `connect()` resolve imediatamente — usado para a "próxima fala" depois do timeout. */
class InstantProvider extends ControllableProvider {
  override connect(_session: ProviderSessionConfig): Promise<void> {
    return Promise.resolve();
  }
}

const ROOM_ID = 'sala_de_estar';

describe('RoomManager: bind dos callbacks na criação da sessão', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('chama o binder com a sala e o provider, antes de entregar a sessão', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const provider = new InstantProvider();
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => provider);

    const binds: Array<{ roomId: string; provider: IAudioProvider }> = [];
    roomManager.setProviderBinder((roomId, bound) => binds.push({ roomId, provider: bound }));

    const created = await roomManager.getOrCreateProvider(ROOM_ID);

    assert.deepEqual(binds, [{ roomId: ROOM_ID, provider }]);
    assert.equal(created, provider);

    await roomManager.destroy();
    ringBuffer.destroy();
  });

  it('não rebinda a sessão já criada — dois binds dobrariam cada frame de áudio', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const provider = new InstantProvider();
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => provider);

    let bindCount = 0;
    roomManager.setProviderBinder(() => {
      bindCount += 1;
    });

    await roomManager.getOrCreateProvider(ROOM_ID);
    await roomManager.getOrCreateProvider(ROOM_ID);

    assert.equal(bindCount, 1);

    await roomManager.destroy();
    ringBuffer.destroy();
  });

  it('connect() que estoura o teto não binda nada: não existe sessão para receber áudio', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const provider = new ControllableProvider();
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => provider);

    let bindCount = 0;
    roomManager.setProviderBinder(() => {
      bindCount += 1;
    });

    await assert.rejects(roomManager.getOrCreateProvider(ROOM_ID));

    assert.equal(bindCount, 0);

    ringBuffer.destroy();
  });
});

describe('RoomManager: timeout de connect()', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('connect() que nunca resolve rejeita no teto configurado', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const provider = new ControllableProvider();
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => provider);

    await assert.rejects(
      roomManager.getOrCreateProvider(ROOM_ID),
      /Timeout ao conectar o provider de áudio/,
    );

    ringBuffer.destroy();
  });

  it('depois do timeout, a fala seguinte tenta conectar de novo (não reencontra a promise morta)', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const stuckProvider = new ControllableProvider();
    const nextProvider = new InstantProvider();
    let calls = 0;
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => {
      calls += 1;
      return calls === 1 ? stuckProvider : nextProvider;
    });

    await assert.rejects(roomManager.getOrCreateProvider(ROOM_ID));

    // pendingConnections precisa ter sido limpo pelo `finally` do
    // getOrCreateProvider: sem isso, esta segunda chamada reencontraria a
    // mesma promise pendurada em vez de tentar de novo.
    const provider = await roomManager.getOrCreateProvider(ROOM_ID);
    assert.equal(provider, nextProvider);
    assert.equal(calls, 2);

    await roomManager.destroy();
    ringBuffer.destroy();
  });

  it('connect() que resolve depois do teto é desconectado assim que assenta (sessão órfã)', async () => {
    const ringBuffer = new ConversationRingBuffer();
    const provider = new ControllableProvider();
    const roomManager = new RoomManager(baseConfig, ringBuffer, () => provider);

    await assert.rejects(roomManager.getOrCreateProvider(ROOM_ID));
    assert.equal(provider.disconnectCalls, 0);

    provider.resolveConnect();
    // O `.then` que desconecta a sessão órfã roda em background; dá uma volta
    // no microtask queue para ele assentar.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(provider.disconnectCalls, 1);

    ringBuffer.destroy();
  });
});
