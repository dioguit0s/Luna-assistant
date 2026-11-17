export const AUDIO_CHUNK_SIZE = 640;

export type MessageType =
  | 'auth'
  | 'audio_chunk'
  | 'wake_clip'
  | 'activity_end'
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
