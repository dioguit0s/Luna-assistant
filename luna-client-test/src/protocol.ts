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
  // Servidor → satélite: o painel mudando configuração (hoje só a sala), e a
  // resposta. Este cliente não aplica nada — responde "não suportado" para a
  // rota do painel não ficar esperando o timeout (ver docs/protocolo-websocket.md).
  | 'set_config'
  | 'config_ack'
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
  /** `set_config` e `config_ack`: casa a resposta com o pedido. */
  request_id?: string;
  /** `set_config`: campos a mudar, todos opcionais. Hoje só `room_id`. */
  config?: Record<string, unknown>;
  /** `config_ack`: se todos os campos foram aplicados. */
  ok?: boolean;
  /** `config_ack`: resultado por campo pedido. */
  results?: Record<string, { ok: boolean; error?: string }>;
  /** `config_ack`: se o satélite vai reconectar para a mudança valer. */
  reconnect?: boolean;
}

export function createEnvelope(
  type: MessageType,
  roomId: string,
  extra: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return { type, room_id: roomId, ts: Date.now(), ...extra };
}

/**
 * `config_ack` recusando todo campo de um `set_config`: a sala deste cliente
 * vem da configuração local, não da NVS de um ESP32. Sem resposta, a rota do
 * painel esperaria o timeout inteiro para dizer a mesma coisa.
 */
export function unsupportedConfigAck(request: MessageEnvelope, roomId: string): MessageEnvelope {
  const fields =
    request.config && typeof request.config === 'object' && !Array.isArray(request.config)
      ? Object.keys(request.config)
      : [];
  return createEnvelope('config_ack', roomId, {
    request_id: typeof request.request_id === 'string' ? request.request_id : '',
    ok: false,
    reconnect: false,
    results: Object.fromEntries(fields.map((f) => [f, { ok: false, error: 'não suportado' }])),
  });
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
