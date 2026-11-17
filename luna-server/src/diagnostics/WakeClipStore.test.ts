import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import type { MessageEnvelope } from '../ws/protocol.js';
import { WakeClipStore, wavHeader } from './WakeClipStore.js';

createLogger({ logLevel: 'silent' } as AppConfig);

function part(
  clipId: number,
  index: number,
  parts: number,
  extra: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return { type: 'wake_clip', room_id: 'sala', clip_id: clipId, part: index, parts, ...extra };
}

/** Parte de 640 bytes cujas amostras valem `fill` — dá para conferir a ordem no WAV. */
function pcm(fill: number): Buffer {
  const buf = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) buf.writeInt16LE(fill, i * 2);
  return buf;
}

function sendClip(store: WakeClipStore, clipId: number, parts: number, extra: Partial<MessageEnvelope> = {}) {
  for (let i = 0; i < parts; i++) {
    store.addPart('aa:bb:cc', 'sala', part(clipId, i, parts, extra), pcm(i));
  }
}

describe('WakeClipStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wake-clips-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('monta as partes em ordem e grava WAV + JSON com o rótulo no nome', async () => {
    const store = new WakeClipStore({ dir, now: () => Date.UTC(2026, 10, 14, 12, 0, 0) });
    sendClip(store, 42, 3, { prob: 0.873, responded: false });
    await store.flush();

    const files = (await readdir(dir)).sort();
    assert.equal(files.length, 2);
    const wav = files.find((f) => f.endsWith('.wav'))!;
    assert.match(wav, /^20261114T120000_000Z_sala_aa-bb-cc_noresp_p0\.873\.wav$/);

    const data = await readFile(join(dir, wav));
    assert.deepEqual(data.subarray(0, 44), wavHeader(3 * 640));
    // Primeira amostra de cada parte, na ordem em que foram mandadas.
    assert.equal(data.readInt16LE(44), 0);
    assert.equal(data.readInt16LE(44 + 640), 1);
    assert.equal(data.readInt16LE(44 + 1280), 2);

    const meta = JSON.parse(await readFile(join(dir, wav.replace('.wav', '.json')), 'utf8'));
    assert.equal(meta.clip_id, 42);
    assert.equal(meta.prob, 0.873);
    assert.equal(meta.responded, false);
    assert.equal(meta.duration_ms, 60);
    assert.equal(meta.label, null);
  });

  it('parte faltando descarta o clipe inteiro', async () => {
    const store = new WakeClipStore({ dir });
    store.addPart('dev', 'sala', part(1, 0, 3), pcm(0));
    store.addPart('dev', 'sala', part(1, 2, 3), pcm(2)); // pulou a 1
    store.addPart('dev', 'sala', part(1, 1, 3), pcm(1));
    await store.flush();
    assert.deepEqual(await readdir(dir), []);
  });

  it('recomeçar da parte 0 (reconexão) substitui o que havia', async () => {
    const store = new WakeClipStore({ dir });
    store.addPart('dev', 'sala', part(1, 0, 2), pcm(9));
    sendClip(store, 1, 2, { responded: true });
    await store.flush();
    const wav = (await readdir(dir)).find((f) => f.endsWith('.wav'))!;
    assert.match(wav, /_resp_pNA\.wav$/);
    const data = await readFile(join(dir, wav));
    assert.equal(data.length, 44 + 2 * 640);
    assert.equal(data.readInt16LE(44), 0);
  });

  it('clipe parado além do timeout é esquecido', async () => {
    let now = 0;
    const store = new WakeClipStore({ dir, partialTimeoutMs: 1000, now: () => now });
    store.addPart('dev', 'sala', part(1, 0, 2), pcm(0));
    now = 5000;
    store.addPart('dev', 'sala', part(1, 1, 2), pcm(1));
    await store.flush();
    assert.deepEqual(await readdir(dir), []);
  });

  it('recusa partes malformadas', async () => {
    const store = new WakeClipStore({ dir });
    store.addPart('dev', 'sala', part(1, 0, 151), pcm(0)); // parts acima do teto (150)
    store.addPart('dev', 'sala', part(2, 0, 1), Buffer.alloc(3)); // PCM ímpar
    store.addPart('dev', 'sala', part(3, 0, 1), Buffer.alloc(2048)); // frame grande
    store.addPart('dev', 'sala', { type: 'wake_clip', room_id: 'sala' }, pcm(0)); // sem clip_id
    await store.flush();
    assert.deepEqual(await readdir(dir), []);
  });

  it('passado o teto, apaga os clipes mais antigos', async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new WakeClipStore({ dir, maxClips: 2, now: () => now });
    for (let clip = 1; clip <= 3; clip++) {
      sendClip(store, clip, 1);
      now += 1000;
    }
    await store.flush();
    const wavs = (await readdir(dir)).filter((f) => f.endsWith('.wav')).sort();
    assert.equal(wavs.length, 2);
    assert.match(wavs[0]!, /^20260101T000001/);
    assert.equal((await readdir(dir)).length, 4); // cada WAV com seu JSON
  });

  it('sem diretório é no-op', async () => {
    const store = WakeClipStore.fromEnv({});
    assert.equal(store.enabled, false);
    sendClip(store, 1, 1);
    await store.flush();
  });
});
