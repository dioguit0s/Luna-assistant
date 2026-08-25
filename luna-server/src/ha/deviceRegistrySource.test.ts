import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { HomeAssistantClient } from './HomeAssistantClient.js';
import { toDeviceEntry } from './deviceRegistry.js';
import {
  DeviceRegistrySource,
  EMPTY_OVERRIDES,
  loadDeviceOverrides,
  parseDeviceOverrides,
} from './deviceRegistrySource.js';

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

/** Mock de `fetch` que devolve o corpo de `/api/template` que o teste quiser. */
function templateFetch(bodies: Array<string | Error>): typeof fetch {
  let call = 0;
  return (async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)]!;
    if (body instanceof Error) throw body;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

const DUAS_ENTIDADES = JSON.stringify([
  { device: 'luz_bancada', room_id: 'oficina', entity_id: 'switch.luz_bancada', name: 'Luz da Bancada' },
  { device: 'luz', room_id: 'cozinha', entity_id: 'light.luz_cozinha', name: 'Luz' },
]);

function sourceWith(bodies: Array<string | Error>, overrides = EMPTY_OVERRIDES) {
  const client = new HomeAssistantClient(baseConfig, templateFetch(bodies));
  return new DeviceRegistrySource(client, overrides, 60_000);
}

describe('DeviceRegistrySource — descoberta', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('monta o registro a partir das áreas do Home Assistant', async () => {
    const source = sourceWith([DUAS_ENTIDADES]);
    await source.refresh();

    const result = source.current().resolve('luz_bancada', 'oficina');

    assert.equal(result.ok && result.entry.entityId, 'switch.luz_bancada');
    assert.equal(result.ok && result.entry.domain, 'switch');
    assert.equal(source.current().size, 2);
  });

  it('usa o area_id como room_id, sem tradução', async () => {
    const source = sourceWith([DUAS_ENTIDADES]);
    await source.refresh();

    assert.deepEqual(source.current().rooms.sort(), ['cozinha', 'oficina']);
  });

  it('descarta entrada malformada sem perder as válidas', async () => {
    const source = sourceWith([
      JSON.stringify([
        { device: 'luz_bancada', room_id: 'oficina', entity_id: 'switch.luz_bancada' },
        { device: 'quebrada', room_id: 'oficina' },
        { entity_id: 'switch.sem_device', room_id: 'oficina' },
      ]),
    ]);
    await source.refresh();

    assert.equal(source.current().size, 1);
    assert.equal(source.current().resolve('luz_bancada', 'oficina').ok, true);
  });

  it('envia o template para /api/template', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
      calls.push(String(input));
      assert.match(String(init.body), /area_entities/);
      return new Response(DUAS_ENTIDADES, { status: 200 });
    }) as unknown as typeof fetch;

    await new DeviceRegistrySource(
      new HomeAssistantClient(baseConfig, fetchImpl),
    ).refresh();

    assert.deepEqual(calls, ['http://ha.local:8123/api/template']);
  });
});

describe('DeviceRegistrySource — resiliência', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('mantém o snapshot anterior quando o refresh falha', async () => {
    const source = sourceWith([DUAS_ENTIDADES, new TypeError('fetch failed')]);

    await source.refresh();
    assert.equal(source.current().size, 2);

    await source.refresh();
    assert.equal(source.current().size, 2, 'HA fora do ar não pode zerar o registro');
    assert.equal(source.current().resolve('luz_bancada', 'oficina').ok, true);
  });

  it('não lança quando a primeira carga falha — sobe só com os overrides', async () => {
    const source = sourceWith([new TypeError('fetch failed')], {
      aliases: {},
      exclude: [],
      devices: [
        toDeviceEntry({
          device: 'luz_manual',
          roomId: 'oficina',
          entityId: 'switch.luz_manual',
        }),
      ],
    });

    await source.start();
    source.stop();

    assert.equal(source.current().resolve('luz_manual', 'oficina').ok, true);
    assert.equal(source.current().resolve('luz_bancada', 'oficina').ok, false);
  });

  it('mantém o snapshot quando o template não devolve JSON', async () => {
    const source = sourceWith([DUAS_ENTIDADES, 'TemplateError: area_entities is undefined']);

    await source.refresh();
    await source.refresh();

    assert.equal(source.current().size, 2);
  });

  it('não deixa o timer de refresh segurar o processo', async () => {
    const source = sourceWith([DUAS_ENTIDADES]);
    await source.start();

    // Se o unref falhasse, o processo de teste não encerraria depois daqui.
    source.stop();
    assert.equal(source.current().size, 2);
  });
});

describe('DeviceRegistrySource — overrides', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('entrada manual vence a descoberta na mesma chave', async () => {
    const source = sourceWith([DUAS_ENTIDADES], {
      aliases: {},
      exclude: [],
      devices: [
        toDeviceEntry({
          device: 'luz_bancada',
          roomId: 'oficina',
          entityId: 'light.luz_bancada_regulavel',
        }),
      ],
    });
    await source.refresh();

    const result = source.current().resolve('luz_bancada', 'oficina');

    assert.equal(result.ok && result.entry.entityId, 'light.luz_bancada_regulavel');
  });

  it('aplica alias e exclude sobre o que foi descoberto', async () => {
    const source = sourceWith([DUAS_ENTIDADES], {
      aliases: { 'luz da bancada': 'luz_bancada' },
      exclude: ['light.luz_cozinha'],
      devices: [],
    });
    await source.refresh();

    assert.equal(source.current().resolve('luz da bancada', 'oficina').ok, true);
    assert.equal(source.current().resolve('luz', 'cozinha').ok, false);
  });
});

describe('parseDeviceOverrides', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('aceita arquivo vazio de campos opcionais', () => {
    assert.deepEqual(parseDeviceOverrides('{}'), EMPTY_OVERRIDES);
  });

  it('lê aliases, exclude e devices', () => {
    const overrides = parseDeviceOverrides(
      JSON.stringify({
        aliases: { luz: 'luz_bancada' },
        exclude: ['switch.tomada_servidor'],
        devices: [
          { device: 'luz_manual', room_id: 'oficina', entity_id: 'switch.luz_manual' },
        ],
      }),
    );

    assert.deepEqual(overrides.aliases, { luz: 'luz_bancada' });
    assert.deepEqual(overrides.exclude, ['switch.tomada_servidor']);
    assert.equal(overrides.devices[0]!.domain, 'switch');
  });

  it('lança em JSON inválido', () => {
    assert.throws(() => parseDeviceOverrides('{nope'), /não é JSON válido/);
  });

  it('lança em campo obrigatório ausente, apontando a entrada', () => {
    assert.throws(
      () => parseDeviceOverrides(JSON.stringify({ devices: [{ device: 'x' }] })),
      /devices\[0\]: campo "room_id" ausente/,
    );
  });

  it('lança em entity_id sem domínio', () => {
    assert.throws(
      () =>
        parseDeviceOverrides(
          JSON.stringify({
            devices: [{ device: 'x', room_id: 'oficina', entity_id: 'luz' }],
          }),
        ),
      /entity_id inválido/,
    );
  });

  it('lança em alias apontando para valor não-string', () => {
    assert.throws(
      () => parseDeviceOverrides(JSON.stringify({ aliases: { luz: 42 } })),
      /alias "luz"/,
    );
  });
});

describe('loadDeviceOverrides', () => {
  before(() => {
    createLogger(baseConfig);
  });

  it('devolve overrides vazios quando o arquivo não existe', () => {
    assert.deepEqual(
      loadDeviceOverrides('config/arquivo-que-nao-existe.json'),
      EMPTY_OVERRIDES,
    );
  });

  it('lê o devices.json versionado do repositório', () => {
    const overrides = loadDeviceOverrides('config/devices.json');

    assert.ok(Array.isArray(overrides.devices));
  });
});
