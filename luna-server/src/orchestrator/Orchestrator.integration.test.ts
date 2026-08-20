import { describe, it, before, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistry, toDeviceEntry } from '../ha/deviceRegistry.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import type { ProviderBinder, RoomManager } from '../rooms/RoomManager.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import type {
  CompletedTurn,
  ProviderSessionConfig,
  ToolCall,
} from '../providers/types.js';
import { parseControlMessage } from '../ws/protocol.js';
import {
  Orchestrator,
  SPEAKING_WATCHDOG_MS,
  MAX_AUDIO_FRAME_BYTES,
  AUDIO_FRAME_INTERVAL_MS,
} from './Orchestrator.js';

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
  private errorCb: ((err: Error) => void) | null = null;
  private sessionEndedCb: (() => void) | null = null;
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
  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  onSessionEnded(callback: () => void): void {
    this.sessionEndedCb = callback;
  }

  emitUserSpeech(): void {
    this.userSpeechCb?.();
  }

  emitAudioResponse(chunk: Buffer): void {
    this.audioResponseCb?.(chunk);
  }

  emitTurnComplete(turn: CompletedTurn): void {
    this.turnCompleteCb?.(turn);
  }

  emitError(err: Error): void {
    this.errorCb?.(err);
  }

  emitSessionEnded(): void {
    this.sessionEndedCb?.();
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
  /** Cria a sessão do cômodo sem ninguém ter falado — o caminho do alarme. */
  startSession: () => Promise<void>;
  /** Payloads que o Orchestrator endereçou a um cômodo, em ordem de envio. */
  sent: Array<Buffer | string>;
  /** Cômodo de destino de cada item de `sent`, no mesmo índice. */
  sentRooms: string[];
  haCalls: FetchCall[];
  evictRoomCalls: string[];
}

/**
 * O ring buffer arma um `setInterval` de despejo no construtor; sem destruí-lo
 * o processo de teste nunca encerra.
 */
const ringBuffers: ConversationRingBuffer[] = [];

async function feedAudio(h: Harness): Promise<void> {
  await h.orchestrator.handleAudioChunk(ROOM_ID, DEVICE_ID, Buffer.alloc(640));
}

function buildHarness(
  respond: (call: FetchCall) => Response | Promise<Response>,
): Harness {
  const provider = new FakeAudioProvider();
  const ringBuffer = new ConversationRingBuffer();
  ringBuffers.push(ringBuffer);

  // RoomManager mínimo: o Orchestrator só chama estes quatro métodos, e a
  // sessão real (connect + tools) já é coberta pelo próprio RoomManager.
  //
  // O bind dos callbacks acontece na criação da sessão, não no primeiro chunk
  // de áudio — então o fake precisa chamar o binder na primeira vez que
  // entrega o provider, como faz `createProviderSession`.
  const evictRoomCalls: string[] = [];
  let bindProvider: ProviderBinder = () => {};
  let bound = false;
  const roomManager = {
    setProviderBinder: (bind: ProviderBinder) => {
      bindProvider = bind;
    },
    getOrCreateProvider: async (roomId: string) => {
      if (!bound) {
        bound = true;
        bindProvider(roomId, provider);
      }
      return provider;
    },
    getRingBuffer: () => ringBuffer,
    evictRoom: (roomId: string) => evictRoomCalls.push(roomId),
  } as unknown as RoomManager;

  const { fetchImpl, calls } = mockFetch(respond);
  const haClient = new HomeAssistantClient(baseConfig, fetchImpl);

  // O fan-out real vive no WsServer (ver WsServer.fanout.test.ts); aqui o que
  // importa é que o Orchestrator só endereça cômodo, nunca conexão.
  const sent: Array<Buffer | string> = [];
  const sentRooms: string[] = [];

  return {
    startSession: async () => {
      await roomManager.getOrCreateProvider(ROOM_ID);
    },
    orchestrator: new Orchestrator(
      baseConfig,
      roomManager,
      haClient,
      registrySource,
      (roomId, payload) => {
        sentRooms.push(roomId);
        sent.push(payload);
        return 1;
      },
    ),
    provider,
    sent,
    sentRooms,
    haCalls: calls,
    evictRoomCalls,
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

  it('endereça tudo pelo cômodo, sem guardar conexão nenhuma', async () => {
    // Era aqui que morava o `sendToClientByRoom`: uma closure por cômodo,
    // reposta a cada chunk de áudio. Ela sobrevivia à reconexão do satélite,
    // mas guardava só a ÚLTIMA conexão que falou — com dois satélites no mesmo
    // cômodo, um deles ficava sem `speaking_start` e sem áudio. Quem sabe
    // quais satélites existem na sala agora é o WsServer; o Orchestrator só
    // diz o cômodo.
    await feedAudio(harness);

    harness.provider.emitAudioResponse(Buffer.alloc(64));
    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }),
    );

    assert.ok(harness.sentRooms.length > 0, 'nada foi endereçado');
    assert.deepEqual(
      [...new Set(harness.sentRooms)],
      [ROOM_ID],
      'todo envio deveria ser endereçado ao cômodo da sessão',
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

  it('nome fora do registro de dispatch: "argumentos inválidos" sem tocar no HA', async () => {
    // O registro casa o nome; nome que não está lá nunca chega a handler
    // nenhum. Para o modelo é a mesma coisa que args inválidos — ele pediu
    // algo que o servidor não sabe executar.
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'on', room_id: ROOM_ID }, 'set_reminder'),
    );

    assert.equal(harness.haCalls.length, 0);
    assert.equal(harness.provider.toolResults.length, 1);
    assert.deepEqual(harness.provider.toolResults[0]!.result, {
      success: false,
      error: 'argumentos inválidos',
    });
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'command_result').length,
      0,
    );
  });

  it('args inválidos: o handler rejeita sem tocar no HA', async () => {
    await feedAudio(harness);

    await harness.provider.emitToolCall(
      toolCall({ device: 'luz_bancada', action: 'talvez', room_id: ROOM_ID }),
    );

    assert.equal(harness.haCalls.length, 0);
    assert.deepEqual(harness.provider.toolResults[0]!.result, {
      success: false,
      error: 'argumentos inválidos',
    });
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'command_result').length,
      0,
    );
  });

  it('sessão criada sem ninguém ter falado já responde áudio', async () => {
    // O bind saiu do primeiro `handleAudioChunk` e foi para a criação da
    // sessão. Sem isso, um provider criado pelo caminho do alarme — que fala
    // sem ter sido perguntado — nasceria sem `onAudioResponse` e a fala do
    // lembrete seria gerada e cairia no vazio, sem erro nenhum.
    await harness.startSession();

    harness.provider.emitAudioResponse(Buffer.alloc(64));

    const tipos = controlMessages(harness.sent).map((msg) => msg.type);
    assert.ok(tipos.includes('speaking_start'), 'faltou speaking_start');
    assert.ok(
      harness.sent.some((item) => Buffer.isBuffer(item)),
      'faltou o frame de áudio',
    );
    assert.deepEqual([...new Set(harness.sentRooms)], [ROOM_ID]);
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
describe('Orchestrator: speaking_end garantido em todo caminho de encerramento', () => {
  before(() => {
    createLogger(baseConfig);
  });

  after(() => {
    for (const buffer of ringBuffers) buffer.destroy();
  });

  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness(() => new Response('[]', { status: 200 }));
  });

  function speakingStarts(h: Harness): number {
    return controlMessages(h.sent).filter((msg) => msg.type === 'speaking_start').length;
  }

  function speakingEnds(h: Harness): number {
    return controlMessages(h.sent).filter((msg) => msg.type === 'speaking_end').length;
  }

  it('onError no meio de uma resposta fecha o par com speaking_end', async () => {
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));
    assert.equal(speakingStarts(harness), 1);
    assert.equal(speakingEnds(harness), 0);

    harness.provider.emitError(new Error('sessão caiu no meio da resposta'));

    assert.equal(
      speakingEnds(harness),
      1,
      'sem isto o satélite ficava preso em RESPONDING até o teto de 20s do firmware',
    );
  });

  it('onSessionEnded no meio de uma resposta fecha o par e evicta a sala', async () => {
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));
    assert.equal(speakingStarts(harness), 1);

    harness.provider.emitSessionEnded();

    assert.equal(speakingEnds(harness), 1, 'speaking_end deve sair antes/junto do evict');
    assert.deepEqual(harness.evictRoomCalls, [ROOM_ID]);
  });

  it('releaseRoom limpa speakingByRoom preso em true: a sessão seguinte volta a mandar speaking_start', async () => {
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));
    assert.equal(speakingStarts(harness), 1);

    // Conexão cai sem o turno fechar (nem onError, nem onSessionEnded — só o
    // WsServer percebendo o socket do satélite morto): releaseRoom é o único
    // ponto que resincroniza o estado antes da próxima sessão da sala.
    harness.orchestrator.releaseRoom(ROOM_ID);

    harness.sent.length = 0;
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));

    assert.equal(
      speakingStarts(harness),
      1,
      'sem releaseRoom, speakingByRoom preso em true faria startSpeaking() retornar cedo',
    );
  });
});

describe('Orchestrator: watchdog de speaking_end sem áudio novo', () => {
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

  function speakingEnds(h: Harness): number {
    return controlMessages(h.sent).filter((msg) => msg.type === 'speaking_end').length;
  }

  it('sem áudio novo por SPEAKING_WATCHDOG_MS, força speaking_end', async () => {
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));

    mock.timers.tick(SPEAKING_WATCHDOG_MS - 1);
    assert.equal(speakingEnds(harness), 0, 'não deveria disparar antes do teto completar');

    mock.timers.tick(1);
    assert.equal(speakingEnds(harness), 1);
  });

  it('resposta longa (áudio contínuo) nunca aciona o watchdog sozinha', async () => {
    await feedAudio(harness);
    harness.provider.emitAudioResponse(Buffer.alloc(4));

    // Três rodadas de "quase o teto, mas sempre chega áudio novo antes":
    // uma resposta de ~24s (3x SPEAKING_WATCHDOG_MS) sem nunca parar de
    // enviar chunks não pode ser cortada pelo watchdog.
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(SPEAKING_WATCHDOG_MS - 100);
      harness.provider.emitAudioResponse(Buffer.alloc(4));
    }

    assert.equal(speakingEnds(harness), 0, 'áudio contínuo deveria ter rearmado o watchdog a cada chunk');

    // E, parando de vez, o watchdog volta a valer.
    mock.timers.tick(SPEAKING_WATCHDOG_MS);
    assert.equal(speakingEnds(harness), 1);
  });
});
describe('Orchestrator: pacing de audio_response (resposta longa não estoura o playback)', () => {
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

  /** Separa o header JSON (contagem de chaves) do payload PCM, espelhando parseAudioMessage. */
  function parseAudioResponseFrame(data: Buffer): { seq: number; payload: Buffer } {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x7b) depth++;
      if (data[i] === 0x7d) {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.notEqual(end, -1, 'header JSON do audio_response não fechou');
    const header = JSON.parse(data.subarray(0, end + 1).toString('utf8')) as {
      type: string;
      seq?: number;
    };
    assert.equal(header.type, 'audio_response');
    return { seq: header.seq!, payload: data.subarray(end + 1) };
  }

  function audioFrames(h: Harness): Buffer[] {
    return h.sent.filter((item): item is Buffer => Buffer.isBuffer(item));
  }

  it('resposta longa: primeiro frame sai imediato, o resto paceado, tudo chega em ordem e completo', async () => {
    await feedAudio(harness);

    // ~10 frames (pouco mais de 10KB) — uma resposta de alguns segundos.
    const FRAME_COUNT = 10;
    const chunk = Buffer.alloc(MAX_AUDIO_FRAME_BYTES * FRAME_COUNT + 37);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;

    harness.provider.emitAudioResponse(chunk);

    // O primeiro frame não espera o intervalo de pacing — preserva o TTFAB.
    assert.equal(audioFrames(harness).length, 1, 'primeiro frame deveria sair na mesma call stack');

    // Avança um frame por vez e confirma que cada um só sai depois do
    // intervalo — nunca todos de uma vez, que é o que estourava o buffer de
    // playback de 512KB do firmware.
    for (let i = 1; i <= FRAME_COUNT; i++) {
      assert.equal(audioFrames(harness).length, i, `frame ${i} deveria já ter saído`);
      mock.timers.tick(AUDIO_FRAME_INTERVAL_MS - 1);
      assert.equal(audioFrames(harness).length, i, 'não deveria adiantar o próximo frame');
      mock.timers.tick(1);
    }

    const frames = audioFrames(harness);
    assert.equal(frames.length, FRAME_COUNT + 1);

    // Reconstrói o payload na ordem de chegada e confere contra o original —
    // prova que nada foi perdido, duplicado ou reordenado.
    const parsed = frames.map(parseAudioResponseFrame);
    const reassembled = Buffer.concat(parsed.map((p) => p.payload));
    assert.deepEqual(reassembled, chunk);

    // seq monotônico: sem isto, frames emitidos no mesmo milissegundo saíam
    // todos com o mesmo Date.now(), inutilizando o campo.
    const seqs = parsed.map((p) => p.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length, 'seq não pode repetir dentro da mesma sala');
  });

  it('speaking_end nunca chega antes do último frame de áudio do mesmo turno', async () => {
    await feedAudio(harness);

    const FRAME_COUNT = 5;
    const chunk = Buffer.alloc(MAX_AUDIO_FRAME_BYTES * FRAME_COUNT);
    harness.provider.emitAudioResponse(chunk);
    assert.equal(audioFrames(harness).length, 1, 'primeiro frame já saiu, os outros 4 ainda estão na fila');

    // Turno fecha (onTurnComplete) com a fila de pacing ainda não vazia — o
    // caso que fazia endSpeaking() mandar speaking_end direto, ultrapassando
    // os frames de áudio ainda presos no pacing e chegando ANTES deles no
    // satélite. Isso arriscava a FSM do firmware sair de RESPONDING (e reabrir
    // o mic) com áudio do próprio turno ainda a caminho.
    harness.provider.emitTurnComplete({ assistantText: 'resposta longa' });

    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'speaking_end').length,
      0,
      'speaking_end não pode sair enquanto ainda há frame de áudio deste turno na fila',
    );

    // Drena os frames restantes; enquanto ainda há MAIS áudio na frente do
    // speaking_end na fila, ele não pode ter saído.
    for (let i = 2; i < FRAME_COUNT; i++) {
      mock.timers.tick(AUDIO_FRAME_INTERVAL_MS);
      assert.equal(audioFrames(harness).length, i);
      assert.equal(
        controlMessages(harness.sent).filter((msg) => msg.type === 'speaking_end').length,
        0,
        `speaking_end não pode sair antes do frame ${i}`,
      );
    }

    // Último frame: o speaking_end enfileirado logo atrás sai no mesmo tick,
    // sem esperar mais um intervalo de pacing — ele não carrega áudio, então
    // não compete pelo buffer de playback do firmware. O que importa é a
    // ORDEM (verificada abaixo), não uma pausa extra antes dele.
    mock.timers.tick(AUDIO_FRAME_INTERVAL_MS);
    assert.equal(audioFrames(harness).length, FRAME_COUNT);
    assert.equal(
      controlMessages(harness.sent).filter((msg) => msg.type === 'speaking_end').length,
      1,
    );

    // E, na ordem real de chegada ao satélite (harness.sent preserva a ordem
    // de envio), o speaking_end aparece depois de todo frame de áudio.
    let lastAudioIndex = -1;
    for (let i = 0; i < harness.sent.length; i++) {
      if (Buffer.isBuffer(harness.sent[i])) lastAudioIndex = i;
    }
    const speakingEndIndex = harness.sent.findIndex(
      (item) => typeof item === 'string' && parseControlMessage(item)?.type === 'speaking_end',
    );
    assert.ok(speakingEndIndex > lastAudioIndex, 'speaking_end deve vir depois de todo frame de áudio do turno');
  });

  it('releaseRoom descarta a fila pendente: turno morto não vaza para a sessão seguinte', async () => {
    await feedAudio(harness);

    const chunk = Buffer.alloc(MAX_AUDIO_FRAME_BYTES * 5);
    harness.provider.emitAudioResponse(chunk);
    assert.equal(audioFrames(harness).length, 1, 'só o primeiro frame saiu até aqui');

    harness.orchestrator.releaseRoom(ROOM_ID);

    // Mesmo avançando bem além do que faltava da resposta antiga, nada mais
    // deveria sair: a fila e o timer de drain foram descartados.
    mock.timers.tick(AUDIO_FRAME_INTERVAL_MS * 10);
    assert.equal(audioFrames(harness).length, 1, 'fila da sessão morta vazou para depois do releaseRoom');
  });
});
