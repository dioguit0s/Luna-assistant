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

  let braceDepth = 0;
  let jsonEnd = -1;

  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7b) braceDepth++;
    if (data[i] === 0x7d) {
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
