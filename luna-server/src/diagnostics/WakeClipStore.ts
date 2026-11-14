import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getLogger } from '../logging/logger.js';
import type { MessageEnvelope } from '../ws/protocol.js';

/**
 * Grava os clipes de wake que os satélites mandam (`wake_clip`) como WAV + JSON,
 * para virar material de treino da wake word (ver `wake-training/README.md`,
 * "Coleta de disparos reais").
 *
 * Cada clipe são os ~2 s que o detector do satélite ouviu até disparar, em
 * partes de 20 ms enviadas em ordem depois que o turno acaba. O nome do arquivo
 * já traz o que ajuda a separar falso de verdadeiro sem abrir: `noresp` (o turno
 * não teve resposta — candidato forte a falso disparo) e a probabilidade.
 *
 * Desligado por default: ligar com `WAKE_CLIP_DIR`. Em produção, dentro do
 * `StateDirectory` (ex. `/var/lib/luna-server/wake-clips`) — a unit roda com
 * `ProtectSystem=strict`, ver deploy/README.md. Desligado, as partes são
 * descartadas em silêncio: o satélite manda de qualquer jeito.
 */
export const WAKE_CLIP_SAMPLE_RATE = 16_000;
/**
 * 3 s em partes de 20 ms: o firmware manda 2 s (100 partes); acima disso é
 * frame errado. Junto com `MAX_PART_BYTES`, limita o pior caso em disco a
 * ~150 KB por clipe (o normal são ~64 KB) — é o que o teto `WAKE_CLIP_MAX` mede.
 */
export const WAKE_CLIP_MAX_PARTS = 150;
/**
 * Teto de PCM por parte. O firmware manda 640 bytes (`AUDIO_CHUNK_SIZE`); o
 * `maxPayload` de 64 KB do WebSocket deixaria passar muito mais.
 */
const MAX_PART_BYTES = 1024;
/** Clipes montando ao mesmo tempo, somando todos os satélites. */
const MAX_PARTIALS = 16;

export interface WakeClipStoreOptions {
  /** Diretório de saída; vazio/ausente desliga. */
  dir?: string;
  /** Teto de clipes no diretório: passado ele, os mais antigos são apagados. */
  maxClips?: number;
  /**
   * Clipe parado por mais que isto é descartado. Longo de propósito: o satélite
   * pausa o envio se um wake novo abrir um turno no meio (até ~20 s de escuta).
   */
  partialTimeoutMs?: number;
  now?: () => number;
}

interface PartialClip {
  deviceId: string;
  roomId: string;
  clipId: number;
  parts: number;
  prob: number | null;
  responded: boolean | null;
  chunks: Buffer[];
  lastPartAt: number;
}

export class WakeClipStore {
  private readonly dir: string | undefined;
  private readonly maxClips: number;
  private readonly partialTimeoutMs: number;
  private readonly now: () => number;
  private readonly partials = new Map<string, PartialClip>();
  /** Serializa as escritas (e o prune) — e é o que `flush()` espera. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WakeClipStoreOptions = {}) {
    this.dir = options.dir && options.dir.length > 0 ? options.dir : undefined;
    this.maxClips = options.maxClips ?? 2000;
    this.partialTimeoutMs = options.partialTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WakeClipStore {
    const max = Number(env.WAKE_CLIP_MAX);
    return new WakeClipStore({
      dir: env.WAKE_CLIP_DIR?.trim(),
      maxClips: Number.isInteger(max) && max > 0 ? max : undefined,
    });
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  /** Uma parte de um `wake_clip`. Fora de ordem ou malformada descarta o clipe. */
  addPart(deviceId: string, roomId: string, envelope: MessageEnvelope, pcm: Buffer): void {
    if (!this.enabled) return;
    const now = this.now();
    this.sweep(now);

    const { clip_id: clipId, part, parts } = envelope;
    if (
      !isUint(clipId) ||
      !isUint(part) ||
      !isUint(parts) ||
      parts < 1 ||
      parts > WAKE_CLIP_MAX_PARTS ||
      part >= parts ||
      pcm.length === 0 ||
      pcm.length > MAX_PART_BYTES ||
      pcm.length % 2 !== 0
    ) {
      getLogger().debug({ event: 'wake_clip_invalid', device_id: deviceId }, 'Parte de wake_clip inválida');
      return;
    }

    const key = `${deviceId}:${clipId}`;
    if (part === 0) {
      // Recomeço (o satélite reconectou no meio) substitui o que havia.
      if (!this.partials.has(key) && this.partials.size >= MAX_PARTIALS) this.dropOldest();
      this.partials.set(key, {
        deviceId,
        roomId,
        clipId,
        parts,
        prob: typeof envelope.prob === 'number' && envelope.prob >= 0 && envelope.prob <= 1 ? envelope.prob : null,
        responded: typeof envelope.responded === 'boolean' ? envelope.responded : null,
        chunks: [],
        lastPartAt: now,
      });
    }

    const partial = this.partials.get(key);
    if (!partial || partial.parts !== parts || partial.chunks.length !== part) {
      // Parte perdida ou fora de ordem: um clipe com buraco não serve de treino.
      this.partials.delete(key);
      return;
    }
    // A última parte traz o `responded` definitivo; a primeira já trazia.
    if (typeof envelope.responded === 'boolean') partial.responded = envelope.responded;
    partial.chunks.push(Buffer.from(pcm));
    partial.lastPartAt = now;

    if (partial.chunks.length === partial.parts) {
      this.partials.delete(key);
      const pcmAll = Buffer.concat(partial.chunks);
      this.queue = this.queue.then(() => this.save(partial, pcmAll, now));
    }
  }

  /** Espera as gravações pendentes (testes e shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }

  private sweep(now: number): void {
    for (const [key, partial] of this.partials) {
      if (now - partial.lastPartAt > this.partialTimeoutMs) this.partials.delete(key);
    }
  }

  private dropOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, partial] of this.partials) {
      if (partial.lastPartAt < oldestAt) {
        oldestAt = partial.lastPartAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.partials.delete(oldestKey);
  }

  private async save(partial: PartialClip, pcm: Buffer, receivedAt: number): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    const durationMs = Math.round((pcm.length / 2 / WAKE_CLIP_SAMPLE_RATE) * 1000);
    const outcome = partial.responded === null ? 'unk' : partial.responded ? 'resp' : 'noresp';
    const prob = partial.prob === null ? 'pNA' : `p${partial.prob.toFixed(3)}`;
    // Carimbo UTC na frente: ordenar por nome é ordenar por tempo (o prune usa isso).
    const stamp = new Date(receivedAt).toISOString().replace(/[-:]/g, '').replace('.', '_');
    const base = `${stamp}_${partial.roomId}_${safeName(partial.deviceId)}_${outcome}_${prob}`;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${base}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]));
      await writeFile(
        join(dir, `${base}.json`),
        `${JSON.stringify(
          {
            received_at: new Date(receivedAt).toISOString(),
            room_id: partial.roomId,
            device_id: partial.deviceId,
            clip_id: partial.clipId,
            prob: partial.prob,
            responded: partial.responded,
            duration_ms: durationMs,
            sample_rate: WAKE_CLIP_SAMPLE_RATE,
            // Para preencher na triagem: "falso" | "verdadeiro".
            label: null,
          },
          null,
          2,
        )}\n`,
      );
      getLogger().info(
        {
          event: 'wake_clip_saved',
          room_id: partial.roomId,
          device_id: partial.deviceId,
          prob: partial.prob,
          responded: partial.responded,
          duration_ms: durationMs,
        },
        `Clipe de wake salvo: ${base}.wav`,
      );
      await this.prune(dir);
    } catch (err) {
      // Ferramenta de coleta: nunca motivo para o servidor cair.
      getLogger().warn({ event: 'wake_clip_save_failed', err: String(err) }, 'Falha ao gravar clipe de wake');
    }
  }

  private async prune(dir: string): Promise<void> {
    const wavs = (await readdir(dir)).filter((f) => f.endsWith('.wav')).sort();
    const excess = wavs.length - this.maxClips;
    for (const wav of wavs.slice(0, Math.max(0, excess))) {
      const base = wav.slice(0, -'.wav'.length);
      await unlink(join(dir, wav)).catch(() => {});
      await unlink(join(dir, `${base}.json`)).catch(() => {});
    }
  }
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** `device_id` vem do satélite (MAC com `:`): só o que é seguro em nome de arquivo. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'unknown';
}

/** Cabeçalho WAV de 44 bytes para PCM16 mono a 16 kHz. */
export function wavHeader(dataBytes: number, sampleRate = WAKE_CLIP_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamanho do bloco fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits por amostra
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
