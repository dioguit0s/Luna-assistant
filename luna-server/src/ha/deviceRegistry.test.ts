import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry, toDeviceEntry } from './deviceRegistry.js';
import type { DeviceEntry } from './deviceRegistry.js';

/** O mesmo `device` ("luz") em dois cômodos: o caso que motiva o registro. */
const entries: DeviceEntry[] = [
  toDeviceEntry({ device: 'luz', roomId: 'oficina', entityId: 'switch.luz_oficina' }),
  toDeviceEntry({ device: 'luz', roomId: 'cozinha', entityId: 'light.luz_cozinha' }),
  toDeviceEntry({
    device: 'luz_bancada',
    roomId: 'oficina',
    entityId: 'switch.luz_bancada',
    name: 'Luz da Bancada',
  }),
  toDeviceEntry({
    device: 'tomada_servidor',
    roomId: 'oficina',
    entityId: 'switch.tomada_servidor',
  }),
];

const registry = DeviceRegistry.fromEntries(entries);

describe('DeviceRegistry.resolve — resolução por cômodo', () => {
  it('resolve o mesmo device para entidades diferentes conforme o cômodo', () => {
    const naOficina = registry.resolve('luz', 'oficina');
    const naCozinha = registry.resolve('luz', 'cozinha');

    assert.equal(naOficina.ok, true);
    assert.equal(naCozinha.ok, true);
    assert.equal(naOficina.ok && naOficina.entry.entityId, 'switch.luz_oficina');
    assert.equal(naCozinha.ok && naCozinha.entry.entityId, 'light.luz_cozinha');
  });

  it('deriva o domínio do entity_id em vez de assumir switch', () => {
    const result = registry.resolve('luz', 'cozinha');

    assert.equal(result.ok && result.entry.domain, 'light');
  });

  it('normaliza caixa e espaço do que o modelo fala', () => {
    assert.equal(registry.resolve('  Luz Bancada ', 'Oficina').ok, true);
  });

  it('resolve também pelo friendly_name, não só pelo object_id', () => {
    // O ESPHome gera object_ids como `luz_bancada_luz_bancada`; o nome bom
    // costuma ser o que a pessoa escreveu no HA.
    const comNome = DeviceRegistry.fromEntries([
      toDeviceEntry({
        device: 'luz_bancada_luz_bancada',
        roomId: 'quarto',
        entityId: 'switch.luz_bancada_luz_bancada',
        name: 'Luz da Bancada',
      }),
    ]);

    assert.equal(comNome.resolve('luz da bancada', 'quarto').ok, true);
    assert.equal(comNome.resolve('luz_bancada_luz_bancada', 'quarto').ok, true);
    assert.equal(comNome.size, 1, 'as duas chaves apontam para uma entidade só');
  });
});

describe('DeviceRegistry.resolve — dispositivo inexistente', () => {
  it('rejeita com unknown_device em vez de falhar em silêncio', () => {
    const result = registry.resolve('ventilador', 'oficina');

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'unknown_device');
  });

  it('devolve mensagem falável citando o dispositivo pedido', () => {
    const result = registry.resolve('ventilador', 'oficina');

    assert.equal(!result.ok && result.error, 'não encontrei o dispositivo "ventilador"');
  });
});

describe('DeviceRegistry.resolve — cômodo sem o dispositivo pedido', () => {
  it('distingue "existe em outro cômodo" de "não existe"', () => {
    const result = registry.resolve('luz_bancada', 'cozinha');

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'device_not_in_room');
  });

  it('cita o cômodo na mensagem, com o rótulo falável', () => {
    const result = registry.resolve('luz_bancada', 'cozinha');

    assert.equal(!result.ok && result.error, 'não há "luz_bancada" na cozinha');
  });

  it('contrai a preposição com o artigo do rótulo — a mensagem é falada', () => {
    const result = registry.resolve('luz_bancada', 'quarto');

    assert.equal(!result.ok && result.error, 'não há "luz_bancada" no quarto');
  });

  it('usa o fallback do rótulo para cômodo sem label cadastrado', () => {
    const result = registry.resolve('luz_bancada', 'porao');

    assert.match((!result.ok && result.error) || '', /no ambiente "porao"/);
  });
});

describe('DeviceRegistry — aliases e exclude', () => {
  it('resolve o apelido para o device real', () => {
    const comAlias = DeviceRegistry.fromEntries(entries, {
      aliases: { 'luz da bancada': 'luz_bancada' },
    });

    const result = comAlias.resolve('luz da bancada', 'oficina');

    assert.equal(result.ok && result.entry.entityId, 'switch.luz_bancada');
  });

  it('remove entidades excluídas do registro', () => {
    const semTomada = DeviceRegistry.fromEntries(entries, {
      exclude: ['switch.tomada_servidor'],
    });

    const result = semTomada.resolve('tomada_servidor', 'oficina');

    assert.equal(!result.ok && result.reason, 'unknown_device');
  });
});

describe('DeviceRegistry — inspeção', () => {
  it('lista os dispositivos de um cômodo', () => {
    assert.deepEqual(
      registry.devicesInRoom('oficina').map((e) => e.device),
      ['luz', 'luz_bancada', 'tomada_servidor'],
    );
  });

  it('não vaza dispositivos de outro cômodo', () => {
    assert.deepEqual(
      registry.devicesInRoom('cozinha').map((e) => e.entityId),
      ['light.luz_cozinha'],
    );
  });

  it('resolveRoom casa um cômodo falado com caixa e espaço diferentes', () => {
    assert.equal(registry.resolveRoom('Oficina'), 'oficina');
    assert.equal(registry.resolveRoom('  cozinha  '), 'cozinha');
  });

  it('resolveRoom devolve null para cômodo que o registro não conhece', () => {
    assert.equal(registry.resolveRoom('garagem'), null);
  });
});

describe('toDeviceEntry', () => {
  it('lança em entity_id sem domínio em vez de aceitar entidade inválida', () => {
    assert.throws(
      () => toDeviceEntry({ device: 'x', roomId: 'oficina', entityId: 'luz_bancada' }),
      /entity_id inválido/,
    );
  });
});
