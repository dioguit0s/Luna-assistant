export const AUDIO_CHUNK_SIZE = 640;

export type MessageType =
  | 'auth'
  | 'audio_chunk'
  | 'wake_clip'
  | 'activity_end'
  | 'device_info'
  | 'config_ack'
  | 'set_config'
  | 'speaking_start'
  | 'audio_response'
  | 'speaking_end'
  | 'command_result'
  | 'ping'
  | 'pong'
  | 'auth_ok'
  | 'auth_error';

export interface MessageEnvelope {
  type: MessageType;
  room_id: string;
  seq?: number;
  ts?: number;
  device_id?: string;
  token?: string;
  reason?: string;
  /** `command_result`: se o comando de automação foi de fato executado. */
  success?: boolean;
  /** `command_result`: o dispositivo falado, como resolvido no registro. */
  device?: string;
  /** `command_result`: a ação aplicada ao dispositivo. */
  action?: 'on' | 'off';
  /** `command_result`: entidade acionada no Home Assistant. */
  entity_id?: string;
  /** `wake_clip`: identifica o clipe (uptime do satélite no disparo). */
  clip_id?: number;
  /** `wake_clip`: índice desta parte, de 0 a `parts - 1`, em ordem. */
  part?: number;
  /** `wake_clip`: total de partes do clipe. */
  parts?: number;
  /** `wake_clip`: média da janela deslizante que disparou o wake. */
  prob?: number;
  /** `wake_clip`: se o turno desse wake teve resposta (`speaking_start`). */
  responded?: boolean;
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
  config?: SatelliteConfigPatch;
  /** `config_ack`: se todos os campos foram aplicados. */
  ok?: boolean;
  /** `config_ack`: resultado por campo pedido. */
  results?: Record<string, ConfigFieldResult>;
  /** `config_ack`: se o satélite vai reconectar para a mudança valer (troca de sala). */
  reconnect?: boolean;
}

/** Corpo do `config` de um `set_config`. Campo ausente = não mexer. */
export interface SatelliteConfigPatch {
  room_id?: string;
}

export interface ConfigFieldResult {
  ok: boolean;
  /** Motivo da recusa: `ocupado`, `não suportado`, formato inválido, falha na NVS. */
  error?: string;
}

export function createEnvelope(
  type: MessageType,
  roomId: string,
  extra: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return {
    type,
    room_id: roomId,
    ts: Date.now(),
    ...extra,
  };
}

export function serializeControlMessage(envelope: MessageEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseControlMessage(raw: string): MessageEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as MessageEnvelope;
    if (!parsed.type || !parsed.room_id) return null;
    return parsed;
  } catch {
    return null;
  }
}
