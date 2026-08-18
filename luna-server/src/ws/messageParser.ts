import { parseControlMessage } from './protocol.js';

export interface ParsedAudioMessage {
  envelope: NonNullable<ReturnType<typeof parseControlMessage>>;
  pcm: Buffer;
}

/**
 * Mensagens de áudio: envelope JSON imediatamente seguido do payload PCM binário
 * no mesmo frame WebSocket.
 */
export function parseAudioMessage(data: Buffer): ParsedAudioMessage | null {
  if (data.length === 0) return null;

  if (data[0] !== 0x7b) {
    return null;
  }

  // Contagem de chaves ciente de string: sem isto, um `{` ou `}` dentro de um
  // valor de string do envelope (ex.: um room_id ou device_id malformado
  // propositalmente) fecharia o header no lugar errado e cortaria o PCM. O
  // firmware tem a mesma lógica em LunaWsClient.cpp — mudar uma sem a outra é
  // a mesma classe de regressão silenciosa do contrato WS (ver CLAUDE.md).
  let braceDepth = 0;
  let jsonEnd = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (byte === 0x5c /* \ */) {
      if (inString) escaped = true;
      continue;
    }
    if (byte === 0x22 /* " */) {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (byte === 0x7b) braceDepth++;
    if (byte === 0x7d) {
      braceDepth--;
      if (braceDepth === 0) {
        jsonEnd = i;
        break;
      }
    }
  }

  if (jsonEnd === -1) return null;

  const jsonStr = data.subarray(0, jsonEnd + 1).toString('utf8');
  const envelope = parseControlMessage(jsonStr);
  if (!envelope || envelope.type !== 'audio_chunk') return null;

  const pcm = data.subarray(jsonEnd + 1);
  return { envelope, pcm };
}
