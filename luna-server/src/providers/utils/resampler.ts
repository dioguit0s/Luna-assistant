/**
 * Reamostragem racional 24kHz <-> 16kHz para o áudio de voz da Luna, via
 * banco de filtros polyphase com um único protótipo FIR compartilhado pelos
 * dois sentidos.
 *
 * ## Por que polyphase, e por que um protótipo só
 *
 * 24k e 16k têm razão racional 3:2, e — o detalhe que decide o desenho —
 * `2 x 24000 = 3 x 16000 = 48000`: um único filtro passa-baixas projetado a
 * 48 kHz serve tanto para down (24k->16k, up=2/down=3) quanto para up
 * (16k->24k, up=3/down=2). A forma polyphase evita construir a grade
 * upsampled inteira (zeros intercalados): para a amostra de saída `k`, só um
 * de `up` "ramos" do filtro é relevante, selecionado por `k*down mod up`.
 *
 * ## Por que a implementação anterior soava robótica
 *
 * A versão antiga era interpolação linear sem filtro de anti-aliasing: em
 * 8 kHz (Nyquist da saída de 16 kHz) ela atenua apenas ~3 dB, então
 * conteúdo de 8-12 kHz do TTS (sibilantes, fricativas) dobra quase sem
 * filtro para 4-8 kHz — o timbre metálico característico. Ela também
 * resetava a fase a cada chunk e descartava a sobra fracionária, criando uma
 * descontinuidade a cada fronteira de chunk do provider.
 *
 * Esta versão tem estado (preserva histórico e fase entre chamadas — ver
 * `RationalResampler`) e usa um filtro Kaiser de 127 taps com corte a
 * 7500 Hz, que atenua o mesmo ponto em mais de 60 dB.
 */

const PROTOTYPE_SAMPLE_RATE_HZ = 48_000; // mmc(24000, 16000)
const PROTOTYPE_NUM_TAPS = 127; // ímpar (Tipo I): atraso de grupo inteiro
const PROTOTYPE_CUTOFF_HZ = 7_500; // abaixo da Nyquist de 8kHz da saída de 16k
const PROTOTYPE_KAISER_BETA = 5.65; // ~-60dB de stopband (Kaiser/Bellanger)

/**
 * I0, a função de Bessel modificada de primeira espécie e ordem 0 — usada na
 * janela de Kaiser. Série de potências, convergência rápida (poucas dezenas
 * de termos) para os betas usados em design de filtro.
 */
function besselI0(x: number): number {
  const y = x / 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 64; k++) {
    term *= (y * y) / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

/**
 * Projeta um FIR passa-baixas por janela de Kaiser, com ganho unitário em DC
 * (soma dos taps aproximadamente 1). `numTaps` deve ser ímpar para atraso de
 * grupo inteiro (Tipo I). Exportada para os testes poderem inspecionar o
 * filtro diretamente (atenuação, simetria) sem depender do resampler inteiro.
 */
export function designKaiserLowpass(
  numTaps: number,
  cutoffHz: number,
  fsHz: number,
  beta: number,
): Float32Array {
  if (numTaps % 2 === 0) {
    throw new Error('numTaps precisa ser ímpar para atraso de grupo inteiro (filtro Tipo I)');
  }
  const middle = (numTaps - 1) / 2;
  const fc = cutoffHz / fsHz; // normalizado à taxa de amostragem (não à Nyquist)
  const i0Beta = besselI0(beta);
  const h = new Float64Array(numTaps);
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - middle;
    // Passa-baixas ideal (sinc), sem a janela ainda.
    const ideal = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const ratio = middle === 0 ? 0 : k / middle;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0Beta;
    h[n] = ideal * window;
    sum += h[n];
  }
  // A janela reduz a área efetiva do sinc truncado, então o ganho DC da soma
  // acima fica um pouco abaixo de 1 (a diferença é pequena, mas real — sem
  // isto o resampler introduziria um erro de ganho sistemático em toda
  // a faixa de passagem, não só em DC). Renormaliza para ganho unitário exato.
  for (let n = 0; n < numTaps; n++) h[n] /= sum;
  return Float32Array.from(h);
}

function bufferToFloat32(pcm16le: Buffer): Float32Array {
  const samples = pcm16le.length >> 1;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = pcm16le.readInt16LE(i * 2);
  return out;
}

function float32ToBuffer(samples: readonly number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), i * 2);
  }
  return out;
}

/**
 * Reamostrador racional (up/down) polyphase, COM ESTADO: preserva fase e
 * histórico de amostras entre chamadas de `process`. Uma instância vive pela
 * duração de uma sessão de provider inteira (não por chunk, não por turno) —
 * é isso que elimina a descontinuidade de fronteira de chunk que a versão
 * antiga tinha.
 *
 * ## O que "com estado" resolve, mecanicamente
 *
 * `process` é sempre causal: a amostra de saída `k` só olha para amostras de
 * entrada já vistas (`base, base-1, base-2, ...`), nunca para o futuro. Isso
 * significa que o "resto" de um chunk (as últimas amostras necessárias para
 * completar a janela do filtro) fica guardado em `history` e é reaproveitado
 * na chamada seguinte — não há reset de fase, não há descontinuidade, e
 * nenhuma amostra é descartada por não caber num chunk.
 *
 * O único ponto onde isso relaxa é `reset()`: reinicia a fase e zera o
 * histórico (equivalente a "silêncio antes do início do stream"), chamado
 * quando uma sessão de provider (re)começa — não a cada turno, pois o áudio
 * dentro de uma sessão é um único stream contínuo por mais que ele apareça
 * em turnos separados no protocolo.
 */
export class RationalResampler {
  private readonly up: number;
  private readonly down: number;
  /** branches[p][j] = h[p + j*up] * up — o ganho *up compensa a inserção de zeros. */
  private readonly branches: readonly Float32Array[];
  private readonly historyLen: number;
  private history: Float32Array;
  private mLocal = 0;

  constructor(up: number, down: number, taps: Float32Array) {
    if (!Number.isInteger(up) || !Number.isInteger(down) || up < 1 || down < 1) {
      throw new Error(`up/down precisam ser inteiros positivos (recebido ${up}/${down})`);
    }
    this.up = up;
    this.down = down;
    const branches: Float32Array[] = [];
    for (let p = 0; p < up; p++) {
      const vals: number[] = [];
      for (let idx = p; idx < taps.length; idx += up) vals.push(taps[idx] * up);
      branches.push(Float32Array.from(vals));
    }
    this.branches = branches;
    // Amostras de histórico suficientes para cobrir o ramo mais longo (p=0).
    this.historyLen = Math.max(1, Math.ceil(taps.length / up));
    this.history = new Float32Array(this.historyLen);
  }

  /** Reinicia fase e histórico — equivalente a silêncio antes do início do stream. */
  reset(): void {
    this.history.fill(0);
    this.mLocal = 0;
  }

  process(pcm16le: Buffer): Buffer {
    if (pcm16le.length === 0) return Buffer.alloc(0);
    return this.advance(bufferToFloat32(pcm16le));
  }

  /**
   * Drena o que ainda está pendente no estado interno tratando "sem mais
   * entrada" como silêncio — a convenção padrão para fechar um filtro FIR
   * causal. Sem isto, o fim de uma sessão perderia permanentemente a última
   * fração de amostra presa no histórico (no máximo um passo de `down`,
   * sub-milissegundo, mas real). Atualiza o estado como qualquer `process`
   * normal — não há "desfazer" depois de chamar: se a sessão continuar, o
   * próximo `process` retoma dali, com o histórico agora parcialmente zerado
   * (o mesmo custo de reabrir com silêncio que `reset()` já assume).
   */
  flush(): Buffer {
    return this.advance(new Float32Array(this.historyLen));
  }

  private advance(xNew: Float32Array): Buffer {
    const H = this.historyLen;
    const combined = new Float32Array(H + xNew.length);
    combined.set(this.history, 0);
    combined.set(xNew, H);
    const L = combined.length;

    const outs: number[] = [];
    let m = this.mLocal;
    for (;;) {
      const base = Math.floor(m / this.up);
      if (base > L - 1) break;
      const p = m - base * this.up;
      const branch = this.branches[p];
      let sum = 0;
      for (let j = 0; j < branch.length; j++) {
        const idx = base - j;
        // idx < 0 = antes do início conhecido do stream: silêncio implícito,
        // não um erro — é a mesma convenção de reset()/flush().
        if (idx >= 0) sum += branch[j] * combined[idx];
      }
      outs.push(sum);
      m += this.down;
    }

    // Rebase: a próxima chamada só guarda as últimas H amostras (a "cauda"
    // que ainda pode ser referenciada por um `base` futuro), e `mLocal` é
    // deslocado pela mesma quantidade para continuar apontando a posição
    // certa dentro dessa nova cauda.
    this.history = combined.slice(L - H, L);
    this.mLocal = m - (L - H) * this.up;

    return float32ToBuffer(outs);
  }
}

let sharedPrototype: Float32Array | null = null;
function prototypeTaps(): Float32Array {
  if (!sharedPrototype) {
    sharedPrototype = designKaiserLowpass(
      PROTOTYPE_NUM_TAPS,
      PROTOTYPE_CUTOFF_HZ,
      PROTOTYPE_SAMPLE_RATE_HZ,
      PROTOTYPE_KAISER_BETA,
    );
  }
  return sharedPrototype;
}

/** 24kHz -> 16kHz (downlink dos dois providers): up=2, down=3. */
export function createDownsampler24kTo16k(): RationalResampler {
  return new RationalResampler(2, 3, prototypeTaps());
}

/** 16kHz -> 24kHz (uplink da OpenAI Realtime): up=3, down=2. */
export function createUpsampler16kTo24k(): RationalResampler {
  return new RationalResampler(3, 2, prototypeTaps());
}

/**
 * Conversão avulsa, sem persistir estado entre chamadas — para ferramentas e
 * scripts que processam um buffer isolado (ex.: pré-render de um único
 * arquivo). Adapters de sessão devem usar `createDownsampler24kTo16k`/
 * `createUpsampler16kTo24k` diretamente e manter a instância viva pela sessão
 * inteira; instanciar um resampler novo por chunk reintroduziria a
 * descontinuidade de fronteira que este módulo existe para eliminar.
 */
export function resampleOneShot(pcm16le: Buffer, up: number, down: number): Buffer {
  const resampler = new RationalResampler(up, down, prototypeTaps());
  const body = resampler.process(pcm16le);
  const tail = resampler.flush();
  return tail.length === 0 ? body : Buffer.concat([body, tail]);
}
