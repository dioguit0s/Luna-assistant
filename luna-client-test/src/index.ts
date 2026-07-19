import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import { computeAuthToken, loadClientConfig, parseArgs } from './config.js';
import { startMicrophoneStream, startPlayback, stopMicrophone, streamWavFile } from './audio.js';
import type { MessageEnvelope } from './protocol.js';
import {
  createEnvelope,
  parseIncomingMessage,
  serializeControlMessage,
} from './protocol.js';
import { readWavPcm16, writeWavPcm16, generateSilence, playPcm16 } from './wav.js';

loadEnv();

const args = parseArgs(process.argv.slice(2));
const cfg = { ...loadClientConfig(), ...args };

let seq = 0;
let lastAudioSentAt: number | null = null;
let speechEndedAt: number | null = null;
let ttfabLogged = false;
let turnIndex = 0;
let turnEndResolve: (() => void) | null = null;
let responsePcm = Buffer.alloc(0);
let playback: { write: (pcm: Buffer) => void; quit: () => void; live: boolean } | null = null;

/** Resolve quando a resposta do turno termina (speaking_end ou silêncio). */
function waitForTurnEnd(timeoutMs = 25000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      turnEndResolve = null;
      console.log(`[turno ${turnIndex}] sem resposta (timeout)`);
      resolve();
    }, timeoutMs);

    turnEndResolve = () => {
      clearTimeout(timer);
      turnEndResolve = null;
      resolve();
    };
  });
}

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

async function playTurn(ws: WebSocket, file: string): Promise<void> {
  const pcm = readWavPcm16(file);
  await streamWavFile(ws, cfg.roomId, pcm, markChunkSent, getSeq, incSeq);

  // Âncora real da medição: fim da fala, antes do padding de silêncio.
  speechEndedAt = performance.now();

  // Equivale ao botão sendo solto no satélite. O servidor só repassa como
  // activityEnd se o provider estiver em modo manual; caso contrário ignora.
  ws.send(serializeControlMessage(createEnvelope('activity_end', cfg.roomId)));

  // Push-to-talk para de transmitir ao soltar o botão. Continuar mandando
  // silêncio aqui reabriria a atividade e interromperia a resposta.
  if (process.env.MANUAL_ACTIVITY === 'true') {
    return;
  }

  const trailingSilenceMs = Number(process.env.TRAILING_SILENCE_MS ?? 500);
  await streamWavFile(
    ws,
    cfg.roomId,
    generateSilence(trailingSilenceMs),
    markChunkSent,
    getSeq,
    incSeq,
  );
}

async function startAudioSource(ws: WebSocket): Promise<void> {
  if (wavFile) {
    const files = wavFile.split(',').map((f) => f.trim()).filter(Boolean);
    console.log(`Modo arquivo: ${files.length} turno(s)`);

    for (const file of files) {
      turnIndex++;
      await playTurn(ws, file);
      // Mesma sessão para todos os turnos: é assim que o uso real acontece,
      // e sessão fria era o que inflava todas as medições anteriores.
      await waitForTurnEnd();
    }

    ws.close();
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
  if (responsePcm.length === 0) {
    turnEndResolve?.();
    return;
  }

  if (!playback?.live) {
    playPcm16(responsePcm);
    console.log(`Reproduzindo resposta (${responsePcm.length} bytes PCM, ${reason})`);
  } else {
    console.log(`Resposta concluída (${responsePcm.length} bytes PCM, ${reason})`);
  }

  if (args.outputFile) {
    writeWavPcm16(args.outputFile, responsePcm);
    console.log(`Resposta salva em ${args.outputFile}`);
  }

  responsePcm = Buffer.alloc(0);
  turnEndResolve?.();
}

function scheduleResponseSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushResponseWav('timeout'), 800);
}

function handleServerEnvelope(envelope: MessageEnvelope, pcm: Buffer): void {
  const { type } = envelope;

  if (type === 'speaking_start') {
    ttfabLogged = false;
    return;
  }

  if (type === 'audio_response' && pcm.length > 0) {
    if (!ttfabLogged && lastAudioSentAt !== null) {
      const now = performance.now();
      console.log(`[TTFAB client] ${Math.round(now - lastAudioSentAt)}ms`);
      if (speechEndedAt !== null) {
        console.log(`[turno ${turnIndex}] EOS→áudio ${Math.round(now - speechEndedAt)}ms`);
      }
      ttfabLogged = true;
    }
    responsePcm = Buffer.concat([responsePcm, pcm]);
    playback?.write(pcm);
    scheduleResponseSave();
    return;
  }

  if (type === 'command_result') {
    const status = envelope.success ? 'ok' : 'falhou';
    console.log(
      `[command_result] ${envelope.device} → ${envelope.action} ` +
        `(${envelope.entity_id}): ${status}`,
    );
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
      let envelope: MessageEnvelope;
      try {
        envelope = JSON.parse(data.toString()) as MessageEnvelope;
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
      handleServerEnvelope(envelope, Buffer.alloc(0));
      return;
    }

    const parsed = parseIncomingMessage(Buffer.from(data as Buffer));
    if (!parsed) return;
    handleServerEnvelope(parsed.envelope, parsed.pcm);
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
