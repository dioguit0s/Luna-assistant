import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMicDump } from './mic-dump.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'luna-mic-dump-'));
}

describe('createMicDump', () => {
  it('devolve null quando LUNA_DUMP_MIC não está setado', () => {
    const dump = createMicDump(tempDir(), {});
    assert.equal(dump, null);
  });

  it('grava em userData quando LUNA_DUMP_MIC=1, com nome carimbado', () => {
    const dir = tempDir();
    const dump = createMicDump(dir, { LUNA_DUMP_MIC: '1' });
    assert.ok(dump);
    assert.ok(dump.path.startsWith(dir));
    assert.match(dump.path, /mic-dump-.*\.wav$/);
    dump.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grava no caminho literal quando LUNA_DUMP_MIC não é "1"', () => {
    const dir = tempDir();
    const explicitPath = join(dir, 'minha-gravacao.wav');
    const dump = createMicDump(dir, { LUNA_DUMP_MIC: explicitPath });
    assert.ok(dump);
    assert.equal(dump.path, explicitPath);
    dump.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('produz um .wav tocável: header com o tamanho real dos frames escritos', () => {
    const dir = tempDir();
    const dump = createMicDump(dir, { LUNA_DUMP_MIC: '1' });
    assert.ok(dump);

    const frame = Buffer.alloc(640, 7); // 640 bytes = 1 frame de 20ms
    for (let i = 0; i < 10; i++) dump.write(frame);
    dump.close();

    const contents = readFileSync(dump.path);
    const expectedDataSize = 640 * 10;
    assert.equal(contents.length, 44 + expectedDataSize);
    assert.equal(contents.readUInt32LE(40), expectedDataSize, 'campo dataSize do header');
    assert.equal(contents.readUInt32LE(4), 36 + expectedDataSize, 'campo fileSize do header');
    // payload íntegro
    assert.ok(contents.subarray(44).equals(Buffer.concat(Array(10).fill(frame))));

    rmSync(dir, { recursive: true, force: true });
  });

  it('write() depois de close() não escreve mais nada (sem crash)', () => {
    const dir = tempDir();
    const dump = createMicDump(dir, { LUNA_DUMP_MIC: '1' });
    assert.ok(dump);
    dump.close();
    assert.doesNotThrow(() => dump.write(Buffer.alloc(640)));
    rmSync(dir, { recursive: true, force: true });
  });

  it('para de gravar ao atingir o teto de LUNA_DUMP_MIC_SECONDS, sem corromper o header', () => {
    const dir = tempDir();
    // 16000 amostras/s * 2 bytes = 32000 bytes/s; teto de 0.01s = 320 bytes.
    const dump = createMicDump(dir, { LUNA_DUMP_MIC: '1', LUNA_DUMP_MIC_SECONDS: '0.01' });
    assert.ok(dump);

    const frame = Buffer.alloc(640, 1); // maior que o teto de 320 bytes
    dump.write(frame); // deveria estourar o teto e parar de gravar
    dump.write(frame); // não deveria acrescentar nada
    dump.close();

    const contents = readFileSync(dump.path);
    // Nada foi de fato escrito além do header, porque o primeiro frame já
    // excede o teto e é descartado por inteiro (sem frames parciais).
    assert.equal(contents.length, 44);
    assert.equal(contents.readUInt32LE(40), 0);

    rmSync(dir, { recursive: true, force: true });
  });
});
