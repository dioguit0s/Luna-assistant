import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type WebSocket from 'ws';
import { CHUNK_BYTES, SAMPLE_RATE, buildAudioMessage } from './protocol.js';

const execFileAsync = promisify(execFile);

async function resolveFfmpegPath(): Promise<string | null> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return 'ffmpeg';
  } catch {
    try {
      const mod = await import('ffmpeg-static');
      const bundled = mod.default;
      return typeof bundled === 'string' ? bundled : null;
    } catch {
      return null;
    }
  }
}

export async function isFfmpegAvailable(): Promise<boolean> {
  return (await resolveFfmpegPath()) !== null;
}

async function findWindowsMicDevice(ffmpegBin: string): Promise<string | null> {
  try {
    const { stderr } = await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { encoding: 'utf8' },
    );
    for (const line of stderr.split('\n')) {
      const match = line.match(/"\s*(.+?)\s*"\s*\(audio\)/i);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function startFfmpegMicrophoneStream(
  ws: WebSocket,
  roomId: string,
  onChunkSent: () => void,
  getSeq: () => number,
  incSeq: () => void,
): Promise<{ stop: () => void }> {
  const ffmpegBin = await resolveFfmpegPath();
  if (!ffmpegBin) {
    throw new Error('ffmpeg não disponível');
  }

  let inputArgs: string[];

  if (process.platform === 'win32') {
    const device = process.env.MIC_DEVICE ?? (await findWindowsMicDevice(ffmpegBin));
    if (!device) {
      throw new Error(
        'Microfone não detectado. Defina MIC_DEVICE no .env (liste com: ffmpeg -list_devices true -f dshow -i dummy)',
      );
    }
    console.log(`Microfone: "${device}"`);
    inputArgs = ['-f', 'dshow', '-i', `audio=${device}`];
  } else if (process.platform === 'darwin') {
    inputArgs = ['-f', 'avfoundation', '-i', ':0'];
  } else {
    inputArgs = ['-f', 'alsa', '-i', 'default'];
  }

  const ffmpeg = spawn(
    ffmpegBin,
    [
      ...inputArgs,
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-sample_fmt',
      's16',
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let buffer = Buffer.alloc(0);

  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= CHUNK_BYTES) {
      const pcm = buffer.subarray(0, CHUNK_BYTES);
      buffer = buffer.subarray(CHUNK_BYTES);
      onChunkSent();
      incSeq();
      ws.send(buildAudioMessage(roomId, getSeq(), pcm));
    }
  });

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const msg = data.toString();
    if (/error/i.test(msg)) {
      console.error('[ffmpeg]', msg.trim());
    }
  });

  ffmpeg.on('error', (err) => {
    console.error('Erro ao iniciar ffmpeg:', err.message);
  });

  return {
    stop: () => ffmpeg.kill('SIGTERM'),
  };
}

export async function startFfmpegPlayback(): Promise<{
  write: (pcm: Buffer) => void;
  quit: () => void;
} | null> {
  try {
    await execFileAsync('ffplay', ['-version']);
  } catch {
    return null;
  }

  const ffplay = spawn(
    'ffplay',
    [
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'quiet',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );

  return {
    write: (pcm: Buffer) => {
      if (!ffplay.killed && ffplay.stdin.writable) {
        ffplay.stdin.write(pcm);
      }
    },
    quit: () => {
      if (!ffplay.killed) {
        ffplay.stdin.end();
        ffplay.kill('SIGTERM');
      }
    },
  };
}
