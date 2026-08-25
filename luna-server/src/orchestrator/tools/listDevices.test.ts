import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import { DeviceRegistry, toDeviceEntry } from '../../ha/deviceRegistry.js';
import type { DeviceRegistrySource } from '../../ha/deviceRegistrySource.js';
import { createListDevicesHandler } from './listDevices.js';
import { INVALID_ARGS_RESULT, type ToolContext } from './types.js';

const ROOM = 'sala_de_estar';

function ctx(roomId: string = ROOM): ToolContext {
  return {
    roomId,
    deviceId: 'esp32-sala',
    provider: {} as IAudioProvider,
    callId: 'call-1',
    modelDecisionMs: null,
  };
}

/** Fake mínimo de `DeviceRegistrySource`: só o que o handler consome, com contador. */
function fakeSource(registry: DeviceRegistry): DeviceRegistrySource & { calls: number } {
  const fake = {
    calls: 0,
    current(): DeviceRegistry {
      fake.calls += 1;
      return registry;
    },
  };
  return fake as unknown as DeviceRegistrySource & { calls: number };
}

const REGISTRY = DeviceRegistry.fromEntries([
  toDeviceEntry({
    device: 'luz_bancada',
    roomId: 'sala_de_estar',
    entityId: 'switch.luz_bancada',
    name: 'Luz da Bancada',
  }),
  toDeviceEntry({
    device: 'ventilador',
    roomId: 'sala_de_estar',
    entityId: 'fan.ventilador',
  }),
  toDeviceEntry({
    device: 'luz_cozinha',
    roomId: 'cozinha',
    entityId: 'light.luz_cozinha',
    name: 'Luz da Cozinha',
  }),
]);

const EMPTY_REGISTRY = DeviceRegistry.fromEntries([]);

describe('createListDevicesHandler', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('args inválidos devolvem INVALID_ARGS_RESULT', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = await handler({ room_id: 7 }, ctx());
    assert.deepEqual(result, INVALID_ARGS_RESULT);
  });

  it('sem room_id, lista o cômodo da sessão', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({}, ctx())) as Record<string, unknown>;
    assert.equal(result.success, true);
    assert.deepEqual(result.devices, ['Luz da Bancada', 'ventilador']);
    assert.equal(result.count, 2);
  });

  it('room_id do modelo, conhecido e diferente da sessão, é respeitado', async () => {
    // Exceção deliberada ao ADR 002: list_devices é read-only, então o
    // room_id gerado pelo modelo é validado e usado, não descartado.
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({ room_id: 'cozinha' }, ctx())) as Record<string, unknown>;
    assert.equal(result.success, true);
    assert.deepEqual(result.devices, ['Luz da Cozinha']);
  });

  it('room_id com caixa e espaço diferentes ainda resolve', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({ room_id: 'Sala De Estar' }, ctx())) as Record<
      string,
      unknown
    >;
    assert.deepEqual(result.devices, ['Luz da Bancada', 'ventilador']);
  });

  it('room_id desconhecido cai no cômodo da sessão e sinaliza unknown_room', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({ room_id: 'garagem' }, ctx())) as Record<string, unknown>;
    assert.equal(result.success, true);
    assert.equal(result.unknown_room, 'garagem');
    assert.deepEqual(result.devices, ['Luz da Bancada', 'ventilador']);
  });

  it('cômodo da sessão sem nenhum dispositivo devolve sucesso com lista vazia', async () => {
    // 'quarto' não tem nenhuma entrada em REGISTRY — cômodo vazio é resposta
    // legítima quando é o cômodo real da sessão, não uma falha.
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({}, ctx('quarto'))) as Record<string, unknown>;
    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.devices, []);
    assert.match(result.spoken as string, /nenhum aparelho/);
  });

  it('rooms vem sempre presente, com os rótulos falados', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({}, ctx())) as Record<string, unknown>;
    assert.deepEqual(result.rooms, ['a sala de estar', 'a cozinha']);
  });

  it('registro vazio devolve falha', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(EMPTY_REGISTRY) });
    const result = (await handler({}, ctx())) as Record<string, unknown>;
    assert.equal(result.success, false);
    assert.ok(typeof result.error === 'string');
  });

  it('nunca expõe entity_id, domain ou estado — só nomes falados', async () => {
    const handler = createListDevicesHandler({ deviceRegistry: fakeSource(REGISTRY) });
    const result = (await handler({}, ctx())) as Record<string, unknown>;
    assert.equal('entity_id' in result, false);
    assert.equal('domain' in result, false);
    assert.equal('state' in result, false);
  });

  it('chama current() a cada invocação — nunca guarda o snapshot', async () => {
    const source = fakeSource(REGISTRY);
    const handler = createListDevicesHandler({ deviceRegistry: source });
    await handler({}, ctx());
    await handler({}, ctx());
    assert.equal(source.calls, 2);
  });
});
