import type WebSocket from 'ws';
import {
  CHANNELS,
  CHUNK_BYTES,
  SAMPLE_RATE,
  buildAudioMessage,
} from './protocol.js';
import {
  isFfmpegAvailable,
  startFfmpegMicrophoneStream,
  startFfmpegPlayback,
} from './ffmpeg-audio.js';

type PortAudio = typeof import('naudiodon');

let micStop: (() => void) | null = null;

export async function startMicrophoneStream(
  ws: WebSocket,
  roomId: string,
  onChunkSent: () => void,
  getSeq: () => number,
  incSeq: () => void,
): Promise<void> {
  try {
    const portAudio: PortAudio = await import('naudiodon');
    console.log('Captura via naudiodon (PortAudio).');

    const audioIn = new portAudio.default.AudioIO({
      inOptions: {
        channelCount: CHANNELS,
        sampleFormat: portAudio.default.SampleFormatInt16,
        sampleRate: SAMPLE_RATE,
        deviceId: -1,
        closeOnError: false,
      },
    });

    let buffer = Buffer.alloc(0);

    audioIn.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= CHUNK_BYTES) {
        const pcm = buffer.subarray(0, CHUNK_BYTES);
        buffer = buffer.subarray(CHUNK_BYTES);
        onChunkSent();
        incSeq();
        ws.send(buildAudioMessage(roomId, getSeq(), pcm));
      }
    });

    audioIn.start();
    micStop = () => audioIn.quit();
    return;
  } catch {
    // naudiodon indisponível — tenta ffmpeg
  }

  if (!(await isFfmpegAvailable())) {
    throw new Error(
      [
        'Microfone indisponível.',
        '',
        'Opções:',
        '  1) npm run dev:wav  — testar com arquivo WAV',
        '  2) Instalar ffmpeg (https://ffmpeg.org) e rodar npm run dev:mic',
        '  3) Instalar naudiodon (requer Visual Studio Build Tools no Windows)',
      ].join('\n'),
    );
  }

  console.log('Captura via ffmpeg (naudiodon não instalado).');
  const session = await startFfmpegMicrophoneStream(
    ws,
    roomId,
    onChunkSent,
    getSeq,
    incSeq,
  );
  micStop = session.stop;
}

export async function startPlayback(): Promise<{
  write: (pcm: Buffer) => void;
  quit: () => void;
}> {
  try {
    const portAudio: PortAudio = await import('naudiodon');
    const stream = new portAudio.default.AudioIO({
      outOptions: {
        channelCount: CHANNELS,
        sampleFormat: portAudio.default.SampleFormatInt16,
        sampleRate: SAMPLE_RATE,
        deviceId: -1,
        closeOnError: false,
      },
    });
    stream.start();

    return {
      write: (pcm: Buffer) => stream.write(pcm),
      quit: () => stream.quit(),
    };
  } catch {
    if (await isFfmpegAvailable()) {
      const ffplay = await startFfmpegPlayback();
      if (ffplay) return ffplay;
    }

    console.warn('Playback ao vivo indisponível — resposta será salva em luna-response.wav');
    return {
      write: () => {},
      quit: () => {},
    };
  }
}

export function stopMicrophone(): void {
  micStop?.();
  micStop = null;
}

export async function streamWavFile(
  ws: WebSocket,
  roomId: string,
  pcm: Buffer,
  onChunkSent: () => void,
  getSeq: () => number,
  incSeq: () => void,
): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
    if (chunk.length < CHUNK_BYTES) {
      const padded = Buffer.alloc(CHUNK_BYTES);
      chunk.copy(padded);
      onChunkSent();
      incSeq();
      ws.send(buildAudioMessage(roomId, getSeq(), padded));
    } else {
      onChunkSent();
      incSeq();
      ws.send(buildAudioMessage(roomId, getSeq(), chunk));
    }
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
