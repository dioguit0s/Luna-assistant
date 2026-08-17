// Dump opcional do microfone para .wav — a fixture de voz real que o marco 3
// do sidecar de wake word precisa (docs/luna-desktop.md, verificação do M3):
// grava exatamente o áudio que passa por `onMicFrame`, ou seja, já pós
// AGC/ruído/eco do `getUserMedia` do Chromium — o mesmo que o sidecar vai
// ouvir em produção via M4, não o de outro microfone/app.
//
// Desligado por padrão. Mesma convenção de flag de ambiente do
// `LUNA_DEBUG_WINDOW` (window.ts): `LUNA_DUMP_MIC=1` grava em `userData` com
// nome carimbado; `LUNA_DUMP_MIC=<caminho>` grava nesse caminho exato.
//
// Isto grava a casa do usuário continuamente enquanto ativo — por isso é
// opt-in só por variável de ambiente (nunca uma chave de `.env` que possa
// ficar ligada sem querer), tem um teto de duração, e loga o caminho alto na
// inicialização.

import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import { wavHeaderPcm16 } from '../shared/wav.js';
import { SAMPLE_RATE } from '../shared/pcm.js';

/** A cada quantos frames o header é corrigido com o tamanho real (~10s a 20ms/frame). */
const PATCH_INTERVAL_FRAMES = 500;

/** Teto de duração — sem isto uma sessão de calibração esquecida ligada grava
 * a casa do usuário indefinidamente. */
const DEFAULT_MAX_SECONDS = 30 * 60;

export interface MicDump {
  readonly path: string;
  write(pcm: Buffer): void;
  close(): void;
}

/**
 * Cria o dump se `LUNA_DUMP_MIC` estiver setado, senão devolve `null` — o
 * chamador usa `micDump?.write(...)` sem precisar checar a flag de novo.
 */
export function createMicDump(userDataDir: string, env: NodeJS.ProcessEnv = process.env): MicDump | null {
  const flag = env.LUNA_DUMP_MIC;
  if (!flag) return null;

  const path =
    flag === '1' ? join(userDataDir, `mic-dump-${timestampForFilename()}.wav`) : flag;

  const maxSeconds = Number(env.LUNA_DUMP_MIC_SECONDS) || DEFAULT_MAX_SECONDS;
  const maxBytes = maxSeconds * SAMPLE_RATE * 2;

  const fd = openSync(path, 'w');
  // Sem `position`: usa (e avança) o offset corrente do fd, que começa em 0
  // logo após o open. É isso que deixa as escritas de frame — também sem
  // `position` — continuarem naturalmente depois do header em vez de
  // reescrever por cima dele a partir do byte 0 (uma escrita com `position`
  // explícito, ao contrário, não avança esse offset — é o que `patchSizes()`
  // explora de propósito para corrigir os tamanhos sem perturbar o fluxo).
  writeSync(fd, wavHeaderPcm16(0));

  let dataSize = 0;
  let framesSinceLastPatch = 0;
  let closed = false;
  let capped = false;

  console.log(`[luna-desktop] LUNA_DUMP_MIC ativo — gravando microfone em ${path}`);

  // Reescreve só os dois campos de tamanho (offsets 4 e 40) sem tocar a
  // posição de escrita corrente do fd (writeSync com `position` explícito não
  // avança o cursor usado pelas escritas de frame, que continuam sem
  // position — ver teste em mic-dump.test.ts).
  function patchSizes(): void {
    const header = wavHeaderPcm16(dataSize);
    writeSync(fd, header, 4, 4, 4); // fileSize
    writeSync(fd, header, 40, 4, 40); // dataSize
  }

  return {
    path,

    write(pcm: Buffer): void {
      if (closed || capped) return;

      if (dataSize + pcm.length > maxBytes) {
        capped = true;
        console.warn(
          `[luna-desktop] LUNA_DUMP_MIC atingiu o teto de ${maxSeconds}s — parei de gravar (${path})`,
        );
        patchSizes();
        return;
      }

      writeSync(fd, pcm);
      dataSize += pcm.length;

      framesSinceLastPatch++;
      if (framesSinceLastPatch >= PATCH_INTERVAL_FRAMES) {
        framesSinceLastPatch = 0;
        patchSizes();
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      patchSizes();
      closeSync(fd);
    },
  };
}

function timestampForFilename(): string {
  // 2026-08-17T14-05-30 — sem ':' (Windows não aceita em nome de arquivo).
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
}
