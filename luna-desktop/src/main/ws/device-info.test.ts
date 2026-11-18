import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';

import { buildDesktopDeviceInfo } from './device-info.js';

const iface = (address: string, mac: string): NetworkInterfaceInfo => ({
  address,
  mac,
  family: 'IPv4',
  internal: false,
  netmask: '255.255.255.0',
  cidr: `${address}/24`,
});

const interfaces = {
  'vEthernet (WSL)': [iface('172.20.0.1', '00:15:5d:aa:bb:cc')],
  'Wi-Fi': [iface('192.168.0.15', 'a1:b2:c3:d4:e5:f6')],
};

describe('buildDesktopDeviceInfo', () => {
  it('usa o endereço local do socket e o MAC da interface dele', () => {
    assert.deepEqual(buildDesktopDeviceInfo('0.1.0', '::ffff:192.168.0.15', interfaces, 1234), {
      fw_version: '0.1.0',
      uptime_ms: 1234,
      ip: '192.168.0.15',
      mac: 'A1:B2:C3:D4:E5:F6',
    });
  });

  it('sem endereço local manda só a versão', () => {
    assert.deepEqual(buildDesktopDeviceInfo('0.1.0', undefined, interfaces, 5), { fw_version: '0.1.0', uptime_ms: 5 });
  });

  it('servidor na mesma máquina (loopback) não vira IP', () => {
    assert.equal(buildDesktopDeviceInfo('0.1.0', '127.0.0.1', interfaces).ip, undefined);
  });

  it('IP sem interface conhecida vai sem MAC', () => {
    const info = buildDesktopDeviceInfo('0.1.0', '10.0.0.9', interfaces);
    assert.equal(info.ip, '10.0.0.9');
    assert.equal(info.mac, undefined);
  });
});
