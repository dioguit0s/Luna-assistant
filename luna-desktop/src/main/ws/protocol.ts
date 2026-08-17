// Contrato de mensagens do WebSocket com o luna-server.
//
// Esta é a TERCEIRA cópia deste contrato no repositório — as outras duas são
// luna-server/src/ws/protocol.ts e luna-firmware/src/ws/. Mudar um lado sem
// os outros é regressão silenciosa (pegadinha documentada no CLAUDE.md).
// Portado do luna-client-test (src/protocol.ts), com um ajuste: o guard de
// `type`/`room_id` em parseControlMessage, que o client-test não tinha mas o
// servidor sempre exigiu.

import { CHUNK_BYTES } from '../../shared/pcm.js';

export { CHUNK_BYTES as AUDIO_CHUNK_SIZE };

export type MessageType =
  | 'auth'
  | 'auth_ok'
  | 'auth_error'
  | 'audio_chunk'
  | 'activity_end'
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
    const parsed = JSON.parse(raw) as MessageEnvelope;
    // Mesmo guard do servidor (WsServer.ts): sem isso um JSON válido mas
    // incompleto passaria adiante e quebraria mais tarde num campo ausente.
    if (!parsed.type || !parsed.room_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildAudioMessage(roomId: string, seq: number, pcm: Buffer): Buffer {
  const header = serializeControlMessage(createEnvelope('audio_chunk', roomId, { seq }));
  return Buffer.concat([Buffer.from(header, 'utf8'), pcm]);
}

/**
 * Frame binário recebido = <JSON UTF-8><PCM16LE cru>, sem prefixo de tamanho.
 * O fim do JSON é achado por profundidade de chaves a partir do byte 0 —
 * espelha luna-server/src/ws/messageParser.ts. Não é ciente de strings: um
 * campo com `{`/`}` dentro quebraria isto, mas nenhum campo do envelope tem.
 */
export function parseIncomingMessage(
  data: Buffer,
): { envelope: MessageEnvelope; pcm: Buffer } | null {
  if (data.length === 0 || data[0] !== 0x7b) return null;

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
