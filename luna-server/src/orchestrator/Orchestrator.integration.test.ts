import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistry, toDeviceEntry } from '../ha/deviceRegistry.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import type {
  CompletedTurn,
  ProviderSessionConfig,
  ToolCall,
} from '../providers/types.js';
import { parseControlMessage } from '../ws/protocol.js';
import { Orchestrator } from './Orchestrator.js';

const baseConfig: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'test-key',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0,
  logLevel: 'silent',
  geminiLiveModel: 'test-model',
  openaiRealtimeModel: 'test-model',
  haUrl: 'http://ha.local:8123',
  haToken: 'token-de-teste',
  devicesConfigPath: 'config/devices.json',
  deviceRegistryTtlMs: 300_000,
  geminiVadSilenceMs: null,
  geminiVadEndSensitivity: null,
  geminiManualActivity: false,
  geminiDebugMessages: false,
};

const ROOM_ID = 'sala_de_estar';
const DEVICE_ID = 'esp32-sala';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/**
 * Provider de teste. O port é todo callback: o fake guarda o que o Orchestrator
 * registrou e expõe `emitToolCall` para simular a IA decidindo acionar a tool.
 */
class FakeAudioProvider implements IAudioProvider {
  readonly sentAudio: Buffer[] = [];
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];
  activityEndCount = 0;

  private toolCallCb: ((call: ToolCall) => void) | null = null;
  /** Resolvida no próximo `sendToolResult` — evita sleep nos testes. */
  private nextResult: (() => void) | null = null;

  async connect(_session: ProviderSessionConfig): Promise<void> {}

  sendAudio(pcm16kHz: Buffer): void {
    this.sentAudio.push(pcm16kHz);
  }

  signalActivityEnd(): void {
    this.activityEndCount += 1;
  }

  onAudioResponse(_callback: (chunk: Buffer) => void): void {}
  onUserSpeech(_callback: () => void): void {}
  onTurnComplete(_callback: (turn: CompletedTurn) => void): void {}
  onError(_callback: (err: Error) => void): void {}

  onToolCall(callback: (call: ToolCall) => void): void {
    this.toolCallCb = callback;
  }

  sendToolResult(callId: string, result: unknown): void {
    this.toolResults.push({ callId, result });
    this.nextResult?.();
    this.nextResult = null;
  }

  async disconnect(): Promise<void> {}

  /**
   * Dispara a tool call e só resolve quando o Orchestrator devolver o
   * resultado. O caminho do HA é assíncrono dentro de um callback síncrono;
   * esperar pelo `sendToolResult` é mais firme que ceder o event loop no escuro.
   */
  emitToolCall(call: ToolCall): Promise<void> {
    assert.ok(this.toolCallCb, 'Orchestrator não registrou onToolCall');
    const settled = new Promise<void>((resolve) => {
      this.nextResult = resolve;
    });
    this.toolCallCb(call);
    return settled;
  }
}

const REGISTRY = DeviceRegistry.fromEntries([
  toDeviceEntry({
    device: 'luz_bancada',
    roomId: ROOM_ID,
    entityId: 'switch.luz_bancada',
    name: 'Luz da Bancada',
  }),
  toDeviceEntry({
    device: 'luz_forno',
    roomId: 'cozinha',
    entityId: 'switch.luz_forno',
  }),
]);

/** O registro real, sem o ciclo de descoberta: `current()` é o único uso. */
const registrySource = {
  current: () => REGISTRY,
} as unknown as DeviceRegistrySource;

function toolCall(args: Record<string, unknown>, name = 'control_device'): ToolCall {
  return { callId: 'call-1', name, args };
}

interface Harness {
  orchestrator: Orchestrator;
  provider: FakeAudioProvider;
  sent: Array<Buffer | string>;
  haCalls: FetchCall[];
}

/**
 * O ring buffer arma um `setInterval` de despejo no construtor; sem destruí-lo
 * o processo de teste nunca encerra.
 */
const ringBuffers: ConversationRingBuffer[] = [];

function buildHarness(
  respond: (call: FetchCall) => Response | Promise<Response>,
): Harness {
  const provider = new FakeAudioProvider();
  const ringBuffer = new ConversationRingBuffer();
  ringBuffers.push(ringBuffer);

  // RoomManager mínimo: o Orchestrator só chama estes dois métodos, e a sessão
  // real (connect + tools) já é coberta pelo próprio RoomManager.
  const roomManager = {
    getOrCreateProvider: async () => provider,
    getRingBuffer: () => ringBuffer,
  } as unknown as RoomManager;

  const { fetchImpl, calls } = mockFetch(respond);
  const haClient = new HomeAssistantClient(baseConfig, fetchImpl);

  return {
    orchestrator: new Orchestrator(baseConfig, roomManager, haClient, registrySource),
    provider,
    sent: [],
    haCalls: calls,
  };
}

/** Mensagens de controle recebidas pelo satélite, já desserializadas. */
function controlMessages(sent: Array<Buffer | string>) {
  return sent
    .filter((item): item is string => typeof item === 'string')
    .map((raw) => parseControlMessage(raw))
    .filter((msg): msg is NonNullable<typeof msg> => msg !== null);
}

describe('Orchestrator: despacho de comandos de automação', () => {
  before(() => {
    createLogger(baseConfig);
  });

  after(() => {
    for (const buffer of ringBuffers) buffer.destroy();
  });

  let harness: Harness;

  // Espelha o corpo real do HA: a entidade chamada volta na lista de
  // mudanças, confirmando a ação (ver HomeAssistantClient.callService — um
  // `[]` sem a entidade é tratado como ambíguo e dispara um GET de estado).
  const okFetch = (call: FetchCall) => {
    if (call.init.method === 'POST') {
      const { entity_id: entityId } = JSON.parse(String(call.init.body)) as {
        entity_id: string;
      };
      return new Response(JSON.stringify([{ entity_id: entityId, state: 'on' }]), {
        status: 200,
      });
    }
    return new Response('[]', { status: 200 });
  };

  beforeEach(() => {
    harness = buildHarness(okFetch);
  });

  async function feedAudio(h: Harness): Promise<void> {
    await h.orchestrator.handleAudioChunk(
      ROOM_ID,
      DEVICE_ID,
      Buffer.alloc(640),
      (data) => h.sent.push(data),
    );
  }

  it('áudio → tool call → HA → sendToolResult → command_result', async () => {
    await feedAudio(harness);
    assert.equal(harness.provider.sentAudio.length, 1);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }),
    );

    // Serviço correto, na entidade correta.
    assert.equal(harness.haCalls.length, 1);
    assert.equal(
      harness.haCalls[0]!.url,
      'http://ha.local:8123/api/services/switch/turn_on',
    );
    assert.deepEqual(JSON.parse(String(harness.haCalls[0]!.init.body)), {
      entity_id: 'switch.luz_bancada',
    });

    // Resultado devolvido à IA.
    assert.deepEqual(harness.provider.toolResults, [
      { callId: 'call-1', result: { success: true } },
    ]);

    // E o satélite avisado.
    const results = controlMessages(harness.sent).filter(
      (msg) => msg.type === 'command_result',
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.room_id, ROOM_ID);
    assert.equal(results[0]!.success, true);
    assert.equal(results[0]!.device, 'luz_bancada');
    assert.equal(results[0]!.action, 'on');
    assert.equal(results[0]!.entity_id, 'switch.luz_bancada');
  });

  it('desliga mapeia para turn_off', async () => {
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'off', room_id: ROOM_ID }),
    );

    assert.equal(
      harness.haCalls[0]!.url,
      'http://ha.local:8123/api/services/switch/turn_off',
    );
  });

  it('descarta o room_id do modelo e resolve pelo cômodo da sessão', async () => {
    await feedAudio(harness);

    // Sessão em sala_de_estar, modelo alucinando "cozinha" (ADR 002). O device
    // existe lá, então resolver pelo args acionaria a entidade errada em vez de
    // falhar — é exatamente o modo de falha silencioso que a regra evita.
    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_forno', action: 'on', room_id: 'cozinha' }),
    );

    assert.equal(harness.haCalls.length, 0);
    const [result] = harness.provider.toolResults;
    assert.equal((result!.result as { success: boolean }).success, false);
  });

  it('dispositivo não resolvido: erro falável e nenhum command_result', async () => {
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'ventilador', action: 'on', room_id: ROOM_ID }),
    );

    assert.equal(harness.haCalls.length, 0);
    assert.deepEqual(harness.provider.toolResults, [
      {
        callId: 'call-1',
        result: { success: false, error: 'não encontrei o dispositivo "ventilador"' },
      },
    ]);

    // Nada foi acionado: o satélite não recebe resultado de comando.
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'command_result').length,
      0,
    );
  });

  it('falha do HA: command_result com success false', async () => {
    harness = buildHarness(() => new Response('erro interno', { status: 500 }));
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }),
    );

    assert.equal(harness.haCalls.length, 1);
    assert.deepEqual(harness.provider.toolResults, [
      {
        callId: 'call-1',
        result: { success: false, error: 'Home Assistant respondeu 500' },
      },
    ]);

    const results = controlMessages(harness.sent).filter(
      (msg) => msg.type === 'command_result',
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.success, false);
    assert.equal(results[0]!.entity_id, 'switch.luz_bancada');
  });

  it('tool desconhecida ou args inválidos: rejeita sem tocar no HA', async () => {
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }, 'outra_tool'),
    );
    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'talvez', room_id: ROOM_ID }),
    );

    assert.equal(harness.haCalls.length, 0);
    assert.equal(harness.provider.toolResults.length, 2);
    for (const { result } of harness.provider.toolResults) {
      assert.deepEqual(result, { success: false, error: 'argumentos inválidos' });
    }
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'command_result').length,
      0,
    );
  });
});
