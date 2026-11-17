export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BIT_DEPTH = 16;
export const CHUNK_SAMPLES = 320;
export const CHUNK_BYTES = CHUNK_SAMPLES * 2;

export type MessageType =
  | 'auth'
  | 'auth_ok'
  | 'auth_error'
  | 'audio_chunk'
  // Só o firmware manda (clipes de wake para treino); aqui só para o tipo
  // acompanhar o contrato — ver docs/protocolo-websocket.md.
  | 'wake_clip'
  | 'activity_end'
  // Satélite → servidor, logo após auth_ok: versão, IP e saúde (ver
  // docs/protocolo-websocket.md). Todos os campos opcionais.
  | 'device_info'
  | 'speaking_start'
  | 'audio_response'
  | 'speaking_end'
  | 'command_result'
  | 'ping'
  | 'pong';

export interface MessageEnvelope {
  type: MessageType;
  room_id: string;
  seq?: number;
  ts?: number;
  device_id?: string;
  token?: string;
  reason?: string;
  success?: boolean;
  device?: string;
  action?: 'on' | 'off';
  entity_id?: string;
  /** `device_info`: versão do firmware (semver) ou do app, no desktop. */
  fw_version?: string;
  /** `device_info`: build do firmware (SHA curto do git, ou `dev`). */
  fw_build?: string;
  /** `device_info`: IP local do satélite (IPv4 no firmware; o desktop pode mandar IPv6). */
  ip?: string;
  /** `device_info`: MAC do satélite. */
  mac?: string;
  /** `device_info`: sinal do Wi-Fi em dBm. Ausente fora de Wi-Fi (desktop). */
  rssi?: number;
  /** `device_info`: heap livre em bytes no envio. */
  free_heap?: number;
  /** `device_info`: uptime do satélite em ms no envio. */
  uptime_ms?: number;
}

export function createEnvelope(
  type: MessageType,
  roomId: string,
  extra: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return { type, room_id: roomId, ts: Date.now(), ...extra };
}

export function serializeControlMessage(envelope: MessageEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseControlMessage(raw: string): MessageEnvelope | null {
  try {
    return JSON.parse(raw) as MessageEnvelope;
  } catch {
    return null;
  }
}

export function buildAudioMessage(
  roomId: string,
  seq: number,
  pcm: Buffer,
): Buffer {
  const header = serializeControlMessage(
    createEnvelope('audio_chunk', roomId, { seq }),
  );
  return Buffer.concat([Buffer.from(header, 'utf8'), pcm]);
}

export function parseIncomingMessage(data: Buffer): {
  envelope: MessageEnvelope;
  pcm: Buffer;
} | null {
  if (data[0] !== 0x7b) return null;

  let depth = 0;
  let jsonEnd = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7b) depth++;
    if (data[i] === 0x7d) {
      depth--;
      if (depth === 0) {
        jsonEnd = i;
        break;
      }
    }
  }
  if (jsonEnd === -1) return null;

  const envelope = parseControlMessage(data.subarray(0, jsonEnd + 1).toString('utf8'));
  if (!envelope) return null;

  return { envelope, pcm: data.subarray(jsonEnd + 1) };
}
