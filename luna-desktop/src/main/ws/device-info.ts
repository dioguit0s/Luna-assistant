// `device_info` do desktop: o app também é satélite e conta ao servidor qual
// versão roda e em que IP está (ver docs/protocolo-websocket.md).

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { MessageEnvelope } from './protocol.js';

export type DeviceInfoFields = Pick<MessageEnvelope, 'fw_version' | 'fw_build' | 'ip' | 'mac' | 'uptime_ms'>;

/** `::ffff:192.168.0.10` → `192.168.0.10`; o resto passa igual. */
function unmapIpv4(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * Monta o `device_info` a partir do endereço LOCAL do socket que fala com o
 * servidor — é a interface que de fato chega nele, não a primeira placa que o
 * Windows listar (VPN, Hyper-V, WSL). O MAC vem da interface com esse endereço.
 *
 * Sem `rssi` nem `free_heap`: não fazem sentido num PC.
 */
export function buildDesktopDeviceInfo(
  appVersion: string,
  localAddress: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  uptimeMs: number = Math.round(process.uptime() * 1000),
): DeviceInfoFields {
  const info: DeviceInfoFields = { fw_version: appVersion, uptime_ms: uptimeMs };
  if (!localAddress) return info;

  const ip = unmapIpv4(localAddress);
  // Loopback (servidor na mesma máquina) não diz nada a quem olha o painel.
  if (ip === '127.0.0.1' || ip === '::1') return info;
  info.ip = ip;

  for (const list of Object.values(interfaces)) {
    const match = list?.find((iface) => iface.address === ip);
    if (match && match.mac !== '00:00:00:00:00:00') {
      info.mac = match.mac.toUpperCase();
      break;
    }
  }
  return info;
}
