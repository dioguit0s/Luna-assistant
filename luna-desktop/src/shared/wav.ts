// Header WAV PCM16 mono — porta de `luna-client-test/src/wav.ts` (`writeWavPcm16`),
// mesmo layout de 44 bytes, extraído aqui porque `mic-dump.ts` escreve o
// header duas vezes (placeholder na abertura, tamanhos corrigidos no close)
// em vez de montar o arquivo inteiro em memória — uma gravação de 30min de
// TV não pode viver num Buffer só.

import { SAMPLE_RATE } from './pcm.js';

export const WAV_HEADER_BYTES = 44;

/**
 * Monta o header de 44 bytes de um WAV PCM16 mono. `dataSize` é o tamanho em
 * bytes do payload PCM — passe 0 para escrever um placeholder e corrigir
 * depois com `patchWavHeaderSizes`.
 */
export function wavHeaderPcm16(dataSize: number, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const fileSize = 36 + dataSize;

  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // tamanho do subchunk fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate = sampleRate * blockAlign
  header.writeUInt16LE(2, 32); // blockAlign (16 bits mono = 2 bytes)
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/** Corrige os dois campos de tamanho (offsets 4 e 40) de um header já escrito. */
export function patchWavHeaderSizes(header: Buffer, dataSize: number): void {
  header.writeUInt32LE(36 + dataSize, 4);
  header.writeUInt32LE(dataSize, 40);
}
