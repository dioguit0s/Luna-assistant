import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { playWavFile } from './playback.js';

const SAMPLE_RATE = 16000;

export function readWavPcm16(path: string): Buffer {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`Arquivo não é WAV: ${path}`);
  }

  const sampleRate = buf.readUInt32LE(24);
  const numChannels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);

  if (bitsPerSample !== 16) {
    throw new Error('Apenas WAV PCM 16-bit suportado');
  }

  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      let pcm: Buffer = Buffer.from(buf.subarray(offset + 8, offset + 8 + chunkSize));
      if (numChannels === 2) {
        pcm = stereoToMono(pcm);
      }
      if (sampleRate !== SAMPLE_RATE) {
        pcm = resamplePcm16(pcm, sampleRate, SAMPLE_RATE);
      }
      return pcm;
    }
    offset += 8 + chunkSize;
  }

  throw new Error('Chunk data não encontrado no WAV');
}

export function writeWavPcm16(path: string, pcm: Buffer, sampleRate = SAMPLE_RATE): void {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  writeFileSync(path, Buffer.concat([header, pcm]));
}

function stereoToMono(stereo: Buffer): Buffer {
  const samples = stereo.length / 4;
  const mono = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const left = stereo.readInt16LE(i * 4);
    const right = stereo.readInt16LE(i * 4 + 2);
    mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }
  return mono;
}

function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  const inputSamples = input.length / 2;
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = input.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = input.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}

export function generateSilence(durationMs: number): Buffer {
  const samples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(samples * 2);
}

export function playPcm16(pcm: Buffer, sampleRate = SAMPLE_RATE): void {
  void playPcm16Async(pcm, sampleRate);
}

async function playPcm16Async(pcm: Buffer, sampleRate = SAMPLE_RATE): Promise<void> {
  try {
    const { AudioIO, SampleFormat16Bit } = await import('naudiodon');
    const speaker = new AudioIO({
      outOptions: {
        channelCount: 1,
        sampleFormat: SampleFormat16Bit,
        sampleRate,
        deviceId: -1,
        closeOnError: true,
      },
    });

    speaker.start();
    speaker.write(pcm);

    const durationMs = (pcm.length / (sampleRate * 2)) * 1000;
    setTimeout(() => {
      try {
        speaker.quit();
      } catch (e) {
        console.error('Erro ao encerrar o stream de audio:', e);
      }
    }, durationMs + 200);
  } catch {
    const tmpPath = join(tmpdir(), `luna-playback-${Date.now()}.wav`);
    writeWavPcm16(tmpPath, pcm, sampleRate);
    await playWavFile(tmpPath);
  }
}
