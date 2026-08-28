import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

import { getLogger } from '../../logging/logger.js';

/**
 * Dump de PCM cru do áudio de resposta, para inspeção espectral offline.
 *
 * Existe porque "a voz está robótica" não é uma observação verificável: sem os
 * dois lados do resampler gravados, não dá para separar um defeito de
 * reamostragem (aliasing dobrando 8-12 kHz para dentro da banda) de uma voz de
 * TTS que já sai assim do provider. Com os dois arquivos, a comparação de
 * espectro no Audacity responde a pergunta em um minuto.
 *
 * Desligado por default: ligar com `AUDIO_DUMP_DIR`. Os arquivos são PCM16
 * mono little-endian sem cabeçalho — importar no Audacity como "Raw Data",
 * 16-bit PCM LE, mono, na taxa que o nome do arquivo indica.
 *
 * Atenção ao deploy: a unit systemd roda com `ProtectSystem=strict`, então o
 * diretório precisa ser gravável para o serviço (na prática, dentro do
 * `StateDirectory`). Ver deploy/README.md.
 */
export class AudioDump {
  private readonly dir: string | undefined;
  private readonly label: string;
  private streams = new Map<string, WriteStream>();
  private turn = 0;
  private failed = false;

  constructor(label: string, dir = process.env.AUDIO_DUMP_DIR) {
    this.label = label;
    this.dir = dir && dir.length > 0 ? dir : undefined;
  }

  get enabled(): boolean {
    return this.dir !== undefined && !this.failed;
  }

  /** Grava um chunk no arquivo do turno atual para `tag` (ex.: '24k-in'). */
  write(tag: string, pcm: Buffer): void {
    if (!this.enabled || pcm.length === 0) return;
    const stream = this.streamFor(tag);
    stream?.write(pcm);
  }

  /**
   * Fecha os arquivos do turno e avança o contador. Chamar quando a resposta
   * termina — um arquivo por turno é o que torna a comparação possível; um
   * arquivo único para a sessão inteira misturaria respostas.
   */
  endTurn(): void {
    if (this.streams.size === 0) return;
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
    this.turn += 1;
  }

  private streamFor(tag: string): WriteStream | undefined {
    const existing = this.streams.get(tag);
    if (existing) return existing;

    const dir = this.dir;
    if (!dir) return undefined;
    try {
      mkdirSync(dir, { recursive: true });
      const name = `${this.label}-t${String(this.turn).padStart(3, '0')}-${tag}.raw`;
      const stream = createWriteStream(join(dir, name));
      // Um EPIPE/EACCES assíncrono no stream derrubaria o processo: o dump é
      // ferramenta de diagnóstico, nunca motivo para o servidor cair.
      stream.on('error', (err) => {
        this.failed = true;
        this.streams.delete(tag);
        getLogger().warn({ event: 'audio_dump_failed', err: String(err) }, 'Dump de áudio falhou');
      });
      this.streams.set(tag, stream);
      return stream;
    } catch (err) {
      this.failed = true;
      getLogger().warn({ event: 'audio_dump_failed', err: String(err) }, 'Dump de áudio falhou');
      return undefined;
    }
  }
}
