import { describe, it, before, beforeEach, afterEach, after, mock } from 'node:test';
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
  geminiThinkingBudget: 0,
  geminiDebugMessages: false,
  userSilenceCutoffMs: 500,
  openaiVadType: 'server_vad',
  openaiVadSilenceMs: null,
  openaiDebugMessages: false,
  openaiVoice: 'marin',
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
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private userSpeechCb: (() => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  /** Resolvida no próximo `sendToolResult` — evita sleep nos testes. */
  private nextResult: (() => void) | null = null;

  async connect(_session: ProviderSessionConfig): Promise<void> {}

  sendAudio(pcm16kHz: Buffer): void {
    this.sentAudio.push(pcm16kHz);
  }

  signalActivityEnd(): void {
    this.activityEndCount += 1;
  }

  onAudioResponse(callback: (chunk: Buffer) => void): void {
    this.audioResponseCb = callback;
  }
  onUserSpeech(callback: () => void): void {
    this.userSpeechCb = callback;
  }
  onTurnComplete(callback: (turn: CompletedTurn) => void): void {
    this.turnCompleteCb = callback;
  }
  onError(_callback: (err: Error) => void): void {}

  emitUserSpeech(): void {
    this.userSpeechCb?.();
  }

  emitAudioResponse(chunk: Buffer): void {
    this.audioResponseCb?.(chunk);
  }

  emitTurnComplete(turn: CompletedTurn): void {
    this.turnCompleteCb?.(turn);
  }

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

async function feedAudio(h: Harness): Promise<void> {
  await h.orchestrator.handleAudioChunk(
    ROOM_ID,
    DEVICE_ID,
    Buffer.alloc(640),
    (data) => h.sent.push(data),
  );
}

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
  // `[]` sem a entidade agendaria uma verificação de estado em background).
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

  it('reconexão do satélite: respostas seguem a conexão atual, não a original', async () => {
    // O provider (RoomManager) sobrevive à reconexão — é o próprio cenário do
    // bug: uma queda abrupta (energia, cabo USB) não manda close frame, o
    // servidor não percebe, e o cômodo segue com o mesmo provider quando o
    // satélite volta com uma conexão (e um sendToClient) novos.
    const sentFirstConnection: Array<Buffer | string> = [];
    const sentSecondConnection: Array<Buffer | string> = [];

    await harness.orchestrator.handleAudioChunk(
      ROOM_ID,
      DEVICE_ID,
      Buffer.alloc(640),
      (data) => sentFirstConnection.push(data),
    );
    await harness.orchestrator.handleAudioChunk(
      ROOM_ID,
      DEVICE_ID,
      Buffer.alloc(640),
      (data) => sentSecondConnection.push(data),
    );

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }),
    );

    const resultsOnDeadConnection = controlMessages(sentFirstConnection).filter(
      (msg) => msg.type === 'command_result',
    );
    assert.equal(
      resultsOnDeadConnection.length,
      0,
      'a conexão original (morta) não deveria receber nada',
    );

    const resultsOnCurrentConnection = controlMessages(sentSecondConnection).filter(
      (msg) => msg.type === 'command_result',
    );
    assert.equal(
      resultsOnCurrentConnection.length,
      1,
      'command_result deveria sair pela conexão atual',
    );
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

describe('Orchestrator: corte de silêncio antecipa speaking_start', () => {
  before(() => {
    createLogger(baseConfig);
  });

  after(() => {
    for (const buffer of ringBuffers) buffer.destroy();
  });

  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness(() => new Response('[]', { status: 200 }));
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  function speakingStarts(h: Harness): number {
    return controlMessages(h.sent).filter((msg) => msg.type === 'speaking_start').length;
  }

  it('silêncio sustentado dispara speaking_start antes de qualquer áudio de resposta', async () => {
    await feedAudio(harness);

    harness.provider.emitUserSpeech();
    mock.timers.tick(baseConfig.userSilenceCutoffMs - 1);
    assert.equal(speakingStarts(harness), 0, 'não deveria antecipar antes do cutoff completar');

    mock.timers.tick(1);
    assert.equal(speakingStarts(harness), 1);
  });

  it('fragmentos repetidos de fala reagendam o timer (não corta no meio da frase)', async () => {
    await feedAudio(harness);

    harness.provider.emitUserSpeech();
    mock.timers.tick(300);
    harness.provider.emitUserSpeech(); // novo fragmento antes do cutoff: reagenda
    mock.timers.tick(300);

    assert.equal(speakingStarts(harness), 0, 'o segundo fragmento deveria ter adiado o corte');

    mock.timers.tick(baseConfig.userSilenceCutoffMs - 300);
    assert.equal(speakingStarts(harness), 1);
  });

  it('primeiro áudio de resposta vence a corrida e cancela o debounce pendente', async () => {
    await feedAudio(harness);

    harness.provider.emitUserSpeech();
    mock.timers.tick(100);
    harness.provider.emitAudioResponse(Buffer.alloc(4));

    assert.equal(speakingStarts(harness), 1, 'áudio deveria disparar speaking_start imediatamente');

    // Avança além do cutoff original: o timer cancelado não pode duplicar o envio.
    mock.timers.tick(baseConfig.userSilenceCutoffMs);
    assert.equal(speakingStarts(harness), 1);
  });

  it('turno fecha sem áudio (tool-only): cancela o debounce, sem speaking_start órfão', async () => {
    await feedAudio(harness);

    harness.provider.emitUserSpeech();
    mock.timers.tick(100);
    harness.provider.emitTurnComplete({});

    mock.timers.tick(baseConfig.userSilenceCutoffMs);
    assert.equal(
      speakingStarts(harness),
      0,
      'o timer pendente deveria ter sido cancelado no fim do turno',
    );
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'speaking_end').length,
      0,
      'sem speaking_start correspondente, não deve mandar speaking_end',
    );
  });
});
