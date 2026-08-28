import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import { ReminderStore } from '../reminders/ReminderStore.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../providers/types.js';
import { WsServer } from './WsServer.js';
import { computeAuthToken } from './auth.js';
import { createEnvelope, parseControlMessage, serializeControlMessage } from './protocol.js';
import type { MessageEnvelope } from './protocol.js';

const config: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'test-key',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0, // porta efêmera
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

const ROOM = 'sala_de_estar';
const OTHER_ROOM = 'cozinha';

/** Provider de teste: só precisa deixar o Orchestrator empurrar áudio de volta. */
class FakeProvider implements IAudioProvider {
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;

  /**
   * Resolve quando o Orchestrator terminou de registrar os callbacks. O chunk
   * de áudio percorre `handleMessage` → `getOrCreateProvider` →
   * `bindProviderCallbacksOnce` de forma assíncrona; emitir a resposta antes
   * disso cairia num callback que ainda não existe. `onSessionEnded` é o
   * último bind da sequência, então serve de marca de "terminou".
   */
  readonly bound: Promise<void>;
  private markBound!: () => void;

  constructor() {
    this.bound = new Promise<void>((resolve) => {
      this.markBound = resolve;
    });
  }

  async connect(_session: ProviderSessionConfig): Promise<void> {}
  sendAudio(_pcm: Buffer): void {}
  signalActivityEnd(): void {}
  onAudioResponse(cb: (chunk: Buffer) => void): void {
    this.audioResponseCb = cb;
  }
  onUserSpeech(_cb: () => void): void {}
  onTurnComplete(cb: (turn: CompletedTurn) => void): void {
    this.turnCompleteCb = cb;
  }
  onError(_cb: (err: Error) => void): void {}
  onToolCall(_cb: (call: ToolCall) => void): void {}
  onSessionEnded(_cb: () => void): void {
    this.markBound();
  }
  sendToolResult(_callId: string, _result: unknown): void {}
  /** Registra as instruções de `speak` para o teste inspecionar. */
  readonly spoken: string[] = [];
  speakResult = true;

  async speak(instruction: string): Promise<boolean> {
    this.spoken.push(instruction);
    return this.speakResult;
  }

  async disconnect(): Promise<void> {}

  emitAudioResponse(chunk: Buffer): void {
    this.audioResponseCb?.(chunk);
  }
  emitTurnComplete(): void {
    this.turnCompleteCb?.({});
  }
}

/** Acumula o que um satélite recebeu, separando controle (texto) de áudio (binário). */
function collect(ws: WebSocket) {
  const control: MessageEnvelope[] = [];
  const binary: Buffer[] = [];
  const waiters: Array<() => void> = [];

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      binary.push(Buffer.from(data as Buffer));
    } else {
      const msg = parseControlMessage(data.toString());
      if (msg) control.push(msg);
    }
    for (const wake of waiters.splice(0)) wake();
  });

  return {
    control,
    binary,
    types: (): string[] => control.map((msg) => msg.type),
    /** Espera até `predicate` valer, acordando a cada mensagem recebida. */
    async until(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 2_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, `timeout esperando ${label}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
  };
}

type Collector = ReturnType<typeof collect>;

describe('WsServer: endereçamento por sala', () => {
  let ringBuffer: ConversationRingBuffer;
  let roomManager: RoomManager;
  let server: WsServer;
  let reminderStore: ReminderStore;
  let provider: FakeProvider;
  let wsUrl: string;
  const openSockets: WebSocket[] = [];

  before(() => {
    createLogger(config);
  });

  beforeEach(async () => {
    ringBuffer = new ConversationRingBuffer();
    provider = new FakeProvider();
    roomManager = new RoomManager(config, ringBuffer, () => provider);
    const haClient = new HomeAssistantClient(config);
    reminderStore = ReminderStore.open(':memory:');
    server = new WsServer(config, roomManager, haClient, new DeviceRegistrySource(haClient), reminderStore, null);
    server.start();

    while (server.port === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    wsUrl = `ws://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) ws.close();
    await server.stop();
    reminderStore.close();
    await roomManager.destroy();
    ringBuffer.destroy();
  });

  /** Conecta e autentica um satélite, devolvendo o socket e o coletor. */
  async function connectSatellite(
    roomId: string,
    deviceId: string,
  ): Promise<{ ws: WebSocket; received: Collector }> {
    const ws = new WebSocket(wsUrl);
    openSockets.push(ws);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const received = collect(ws);
    ws.send(
      serializeControlMessage(
        createEnvelope('auth', roomId, {
          device_id: deviceId,
          token: computeAuthToken(config.wsAuthSecret, deviceId),
        }),
      ),
    );
    await received.until(() => received.types().includes('auth_ok'), 'auth_ok');

    return { ws, received };
  }

  /** Frame de áudio no formato do firmware: envelope JSON seguido do PCM. */
  function audioFrame(roomId: string, pcm: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from(serializeControlMessage(createEnvelope('audio_chunk', roomId)), 'utf8'),
      pcm,
    ]);
  }

  it('dois satélites na mesma sala recebem ambos speaking_start, o áudio e o speaking_end', async () => {
    // O bug: `sendToClientByRoom` guardava UMA closure por cômodo, reposta a
    // cada chunk de áudio. Com dois satélites na mesma sala, só o último que
    // falou recebia a resposta — o outro ficava mudo, sem nem sair de
    // RESPONDING, porque nem o `speaking_start` nem o `speaking_end` chegavam.
    const primeiro = await connectSatellite(ROOM, 'esp32-sala-1');
    const segundo = await connectSatellite(ROOM, 'esp32-sala-2');

    // Só o primeiro fala: é o satélite que capta o comando. O segundo nunca
    // transmitiu áudio nenhum e mesmo assim tem de ouvir a resposta.
    primeiro.ws.send(audioFrame(ROOM, Buffer.alloc(640)));

    const fala = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    await provider.bound;
    provider.emitAudioResponse(fala);
    provider.emitTurnComplete();

    for (const [nome, satelite] of [
      ['primeiro', primeiro],
      ['segundo', segundo],
    ] as const) {
      await satelite.received.until(
        () => satelite.received.types().includes('speaking_end'),
        `speaking_end no ${nome} satélite`,
      );

      const tipos = satelite.received.types();
      assert.equal(
        tipos.filter((t) => t === 'speaking_start').length,
        1,
        `${nome} satélite deveria receber exatamente um speaking_start`,
      );
      assert.equal(
        tipos.filter((t) => t === 'speaking_end').length,
        1,
        `${nome} satélite deveria receber exatamente um speaking_end`,
      );
      assert.equal(
        satelite.received.binary.length,
        1,
        `${nome} satélite deveria receber um frame de áudio`,
      );

      const frame = satelite.received.binary[0]!;
      assert.ok(
        frame.subarray(fala.length * -1).equals(fala),
        `${nome} satélite recebeu PCM diferente do emitido`,
      );
    }
  });

  it('não vaza para outra sala', async () => {
    const sala = await connectSatellite(ROOM, 'esp32-sala-1');
    const cozinha = await connectSatellite(OTHER_ROOM, 'esp32-cozinha');

    sala.ws.send(audioFrame(ROOM, Buffer.alloc(640)));
    await provider.bound;
    provider.emitAudioResponse(Buffer.alloc(8));
    provider.emitTurnComplete();

    await sala.received.until(
      () => sala.received.types().includes('speaking_end'),
      'speaking_end na sala de estar',
    );

    assert.deepEqual(cozinha.received.types(), ['auth_ok']);
    assert.equal(cozinha.received.binary.length, 0);
  });

  it('satélite que sai do ar não interrompe o outro da mesma sala', async () => {
    const primeiro = await connectSatellite(ROOM, 'esp32-sala-1');
    const segundo = await connectSatellite(ROOM, 'esp32-sala-2');

    primeiro.ws.send(audioFrame(ROOM, Buffer.alloc(640)));
    await provider.bound;

    // O provider é cacheado por cômodo e sobrevive à saída de um satélite:
    // com o refcount ainda em 1, a sala não é destruída.
    primeiro.ws.close();
    await new Promise<void>((resolve) => primeiro.ws.on('close', () => resolve()));

    provider.emitAudioResponse(Buffer.alloc(8));
    provider.emitTurnComplete();

    await segundo.received.until(
      () => segundo.received.types().includes('speaking_end'),
      'speaking_end no satélite que ficou',
    );
    assert.equal(segundo.received.binary.length, 1);
  });

  it('sendToRoom devolve quantos satélites receberam — 0 em sala vazia', async () => {
    // O 0 é o sinal de "cômodo mudo" de que o disparo de alarme vai depender.
    assert.equal(server.sendToRoom('quarto', 'ping'), 0);

    await connectSatellite(ROOM, 'esp32-sala-1');
    assert.equal(server.sendToRoom(ROOM, serializeControlMessage(createEnvelope('pong', ROOM))), 1);

    await connectSatellite(ROOM, 'esp32-sala-2');
    assert.equal(server.sendToRoom(ROOM, serializeControlMessage(createEnvelope('pong', ROOM))), 2);
  });
});
