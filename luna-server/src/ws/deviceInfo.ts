import type { MessageEnvelope } from './protocol.js';

/**
 * O que o satélite contou de si no último `device_info` (ver
 * docs/protocolo-websocket.md). Todo campo é opcional: o firmware de amanhã
 * pode mandar menos, e o desktop não tem `rssi`.
 */
export interface DeviceInfo {
  fwVersion?: string;
  fwBuild?: string;
  ip?: string;
  mac?: string;
  rssi?: number;
  freeHeap?: number;
  uptimeMs?: number;
  /** Quando o servidor recebeu (relógio do servidor, não o `ts` do satélite). */
  receivedAt: number;
}

/** Teto por campo de texto: o valor vai parar no painel, não na lógica. */
const MAX_TEXT_LENGTH = 64;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return undefined;
  // Só ASCII imprimível: versão, SHA, IP e MAC nunca têm outra coisa, e isto
  // barra caractere de controle indo parar no log ou no painel.
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extrai os campos de um `device_info`, descartando o que vier com tipo ou
 * formato errado em vez de recusar a mensagem inteira — um campo ruim não
 * pode apagar a versão que veio certa no mesmo envelope.
 */
export function parseDeviceInfo(envelope: MessageEnvelope, receivedAt: number): DeviceInfo {
  const info: DeviceInfo = { receivedAt };
  const fwVersion = text(envelope.fw_version);
  const fwBuild = text(envelope.fw_build);
  const ip = text(envelope.ip);
  const mac = text(envelope.mac);
  const rssi = num(envelope.rssi);
  const freeHeap = num(envelope.free_heap);
  const uptimeMs = num(envelope.uptime_ms);
  if (fwVersion !== undefined) info.fwVersion = fwVersion;
  if (fwBuild !== undefined) info.fwBuild = fwBuild;
  if (ip !== undefined) info.ip = ip;
  if (mac !== undefined) info.mac = mac;
  if (rssi !== undefined) info.rssi = rssi;
  if (freeHeap !== undefined) info.freeHeap = freeHeap;
  if (uptimeMs !== undefined) info.uptimeMs = uptimeMs;
  return info;
}

/** `::ffff:192.168.0.10` (IPv4 mapeado em IPv6, como o Node entrega) → `192.168.0.10`. */
export function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
