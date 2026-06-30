import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import { computeAuthToken, loadClientConfig, parseArgs } from './config.js';
import { startMicrophoneStream, startPlayback, stopMicrophone, streamWavFile } from './audio.js';
import {
  createEnvelope,
  parseIncomingMessage,
  serializeControlMessage,
} from './protocol.js';
import { readWavPcm16, writeWavPcm16, generateSilence } from './wav.js';
import { playWavFile } from './playback.js';

loadEnv();

const args = parseArgs(process.argv.slice(2));
const cfg = { ...loadClientConfig(), ...args };

let seq = 0;
let lastAudioSentAt: number | null = null;
let ttfabLogged = false;
let responsePcm = Buffer.alloc(0);
let playback: { write: (pcm: Buffer) => void; quit: () => void } | null = null;

const wavFile = args.wavFile;
const useMic = args.useMic ?? !wavFile;

function getSeq(): number {
  return seq;
}

function incSeq(): void {
  seq++;
}

function markChunkSent(): void {
  lastAudioSentAt = performance.now();
}

async function startAudioSource(ws: WebSocket): Promise<void> {
  if (wavFile) {
    console.log(`Modo arquivo: ${wavFile}`);
    const pcm = readWavPcm16(wavFile);
    await streamWavFile(ws, cfg.roomId, pcm, markChunkSent, getSeq, incSeq);
    await streamWavFile(ws, cfg.roomId, generateSilence(500), markChunkSent, getSeq, incSeq);
    return;
  }

  if (useMic) {
    await startMicrophoneStream(ws, cfg.roomId, markChunkSent, getSeq, incSeq);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flushResponseWav(reason: string): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (responsePcm.length === 0) return;

  const outPath = args.outputFile ?? 'luna-response.wav';
  writeWavPcm16(outPath, responsePcm);
  console.log(
    `Resposta salva em ${outPath} (${responsePcm.length} bytes PCM, ${reason})`,
  );
  void playWavFile(outPath);
  responsePcm = Buffer.alloc(0);
}

function scheduleResponseSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushResponseWav('timeout'), 800);
}

function handleServerEnvelope(type: string, pcm: Buffer): void {
  if (type === 'speaking_start') {
    ttfabLogged = false;
    return;
  }

  if (type === 'audio_response' && pcm.length > 0) {
    if (!ttfabLogged && lastAudioSentAt !== null) {
      const ttfab = Math.round(performance.now() - lastAudioSentAt);
      console.log(`[TTFAB client] ${ttfab}ms`);
      ttfabLogged = true;
    }
    responsePcm = Buffer.concat([responsePcm, pcm]);
    playback?.write(pcm);
    scheduleResponseSave();
    return;
  }

  if (type === 'speaking_end') {
    lastAudioSentAt = null;
    flushResponseWav('speaking_end');
  }
}

function connect(): WebSocket {
  const ws = new WebSocket(cfg.serverUrl);

  ws.on('open', () => {
    console.log(`Conectado a ${cfg.serverUrl}`);

    const token = computeAuthToken(cfg.authSecret, cfg.deviceId);
    ws.send(
      serializeControlMessage(
        createEnvelope('auth', cfg.roomId, {
          device_id: cfg.deviceId,
          token,
        }),
      ),
    );
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let envelope: { type: string; reason?: string };
      try {
        envelope = JSON.parse(data.toString()) as { type: string; reason?: string };
      } catch {
        return;
      }

      if (envelope.type === 'auth_ok') {
        console.log('Autenticado. Fale no microfone (Ctrl+C para sair).');
        void (async () => {
          try {
            playback = await startPlayback();
            await startAudioSource(ws);
          } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            ws.close();
          }
        })();
        return;
      }

      if (envelope.type === 'auth_error') {
        console.error('Auth falhou:', envelope.reason);
        console.error(
          'Verifique se WS_AUTH_SECRET no .env do cliente é idêntico ao do luna-server',
        );
        ws.close();
        return;
      }

      // speaking_start / speaking_end chegam como JSON puro (não binário)
      handleServerEnvelope(envelope.type, Buffer.alloc(0));
      return;
    }

    const parsed = parseIncomingMessage(Buffer.from(data as Buffer));
    if (!parsed) return;
    handleServerEnvelope(parsed.envelope.type, parsed.pcm);
  });

  ws.on('close', () => {
    console.log('Desconectado.');
    flushResponseWav('disconnect');
    stopMicrophone();
    playback?.quit();
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('Erro WebSocket:', err.message);
  });

  return ws;
}

console.log('Luna Client Test');
console.log(`  Servidor: ${cfg.serverUrl}`);
console.log(`  Sala:     ${cfg.roomId}`);
console.log(`  Device:   ${cfg.deviceId}`);
console.log(`  Modo:     ${wavFile ? `wav (${wavFile})` : 'microfone'}`);

connect();

process.on('SIGINT', () => {
  flushResponseWav('sigint');
  stopMicrophone();
  playback?.quit();
  process.exit(0);
});
