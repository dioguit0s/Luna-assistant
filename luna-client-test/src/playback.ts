import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export async function playWavFile(wavPath: string): Promise<void> {
  const absolute = resolve(wavPath);

  if (process.platform === 'win32') {
    spawn('powershell', [
      '-NoProfile',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${absolute.replace(/'/g, "''")}').PlaySync()`,
    ], { stdio: 'ignore', detached: true }).unref();
    console.log('Reproduzindo resposta...');
    return;
  }

  try {
    spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', absolute], {
      stdio: 'ignore',
      detached: true,
    }).unref();
    console.log('Reproduzindo resposta via ffplay...');
  } catch {
    console.log(`Abra manualmente: ${absolute}`);
  }
}

export async function createAudioStream() {
  const { AudioIO, SampleFormat16Bit } = await import('naudiodon');
  return new AudioIO({
    outOptions: {
      channelCount: 1,
      sampleFormat: SampleFormat16Bit,
      sampleRate: 24000,
      deviceId: -1,
      closeOnError: true,
    },
  });
}
