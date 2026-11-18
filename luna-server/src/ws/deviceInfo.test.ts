import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteAddress, parseDeviceInfo } from './deviceInfo.js';
import { createEnvelope } from './protocol.js';

describe('parseDeviceInfo', () => {
  it('lê todos os campos de um device_info completo', () => {
    const info = parseDeviceInfo(
      createEnvelope('device_info', 'sala', {
        fw_version: '0.4.0',
        fw_build: 'abc1234',
        ip: '192.168.0.42',
        mac: 'A1:B2:C3:D4:E5:F6',
        rssi: -61,
        free_heap: 180_000,
        uptime_ms: 95_000,
      }),
      1000,
    );
    assert.deepEqual(info, {
      fwVersion: '0.4.0',
      fwBuild: 'abc1234',
      ip: '192.168.0.42',
      mac: 'A1:B2:C3:D4:E5:F6',
      rssi: -61,
      freeHeap: 180_000,
      uptimeMs: 95_000,
      receivedAt: 1000,
    });
  });

  it('device_info vazio vira só o carimbo de recebimento', () => {
    assert.deepEqual(parseDeviceInfo(createEnvelope('device_info', 'sala'), 5), { receivedAt: 5 });
  });

  it('descarta campo com tipo ou formato errado e mantém o resto', () => {
    const envelope = {
      ...createEnvelope('device_info', 'sala'),
      fw_version: '0.4.0',
      fw_build: 42,
      ip: 'x'.repeat(65),
      mac: 'aa\nbb',
      rssi: 'forte',
      free_heap: Number.NaN,
      uptime_ms: null,
    } as unknown as Parameters<typeof parseDeviceInfo>[0];
    assert.deepEqual(parseDeviceInfo(envelope, 7), { fwVersion: '0.4.0', receivedAt: 7 });
  });
});

describe('normalizeRemoteAddress', () => {
  it('tira o prefixo de IPv4 mapeado em IPv6', () => {
    assert.equal(normalizeRemoteAddress('::ffff:192.168.0.10'), '192.168.0.10');
    assert.equal(normalizeRemoteAddress('fe80::1'), 'fe80::1');
    assert.equal(normalizeRemoteAddress(undefined), null);
  });
});
