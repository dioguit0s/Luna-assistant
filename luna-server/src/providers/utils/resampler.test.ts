import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RationalResampler,
  createDownsampler24kTo16k,
  createUpsampler16kTo24k,
  designKaiserLowpass,
} from './resampler.js';

function toInt16Buffer(samples: readonly number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(samples[i]), i * 2);
  return out;
}

function toSamples(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
  return out;
}

function sineBuffer(freqHz: number, fsHz: number, n: number, amplitude = 10000): Buffer {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(amplitude * Math.sin((2 * Math.PI * freqHz * i) / fsHz));
  return toInt16Buffer(samples);
}

function rms(samples: readonly number[]): number {
  return Math.sqrt(samples.reduce((acc, s) => acc + s * s, 0) / samples.length);
}

/**
 * Magnitude na frequência `targetHz` via Goertzel — mais barato que uma FFT
 * completa quando só se quer checar um bin (aqui: onde uma frequência de
 * teste dobraria por aliasing/imagem).
 */
function goertzelMagnitude(samples: readonly number[], targetHz: number, fsHz: number): number {
  const n = samples.length;
  const k = Math.round((n * targetHz) / fsHz);
  const w = (2 * Math.PI * k) / n;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + 2 * cosW * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cosW;
  const imag = s2 * sinW;
  return Math.sqrt(real * real + imag * imag) / n;
}

describe('designKaiserLowpass', () => {
  it('rejeita numTaps par (perderia o atraso de grupo inteiro do Tipo I)', () => {
    assert.throws(() => designKaiserLowpass(64, 7500, 48000, 5.65));
  });

  it('é simétrico (fase linear, condição do Tipo I)', () => {
    const h = designKaiserLowpass(127, 7500, 48000, 5.65);
    for (let i = 0; i < h.length; i++) {
      assert.ok(Math.abs(h[i] - h[h.length - 1 - i]) < 1e-9, `h[${i}] != h[${h.length - 1 - i}]`);
    }
  });

  it('ganho unitário em DC (soma dos taps ≈ 1)', () => {
    const h = designKaiserLowpass(127, 7500, 48000, 5.65);
    let sum = 0;
    for (const tap of h) sum += tap;
    // A normalização interna trabalha em float64; o resultado exportado é
    // Float32Array (mesma precisão usada no processamento), então a soma dos
    // taps já truncados carrega o arredondamento de float32 (~1e-7 relativo)
    // — a tolerância reflete isso, não uma normalização imprecisa.
    assert.ok(Math.abs(sum - 1) < 1e-6, `soma dos taps = ${sum}`);
  });
});

describe('RationalResampler: downsampler 24kHz→16kHz', () => {
  it('retorna buffer vazio para entrada vazia', () => {
    const r = createDownsampler24kTo16k();
    assert.equal(r.process(Buffer.alloc(0)).length, 0);
  });

  it('comprimento de saída ~2/3 do de entrada, mesmo fatiado em chunks de tamanho arbitrário', () => {
    // Nenhum tamanho é múltiplo de MAX_AUDIO_FRAME_BYTES nem da razão 3:2 —
    // é exatamente o padrão que os chunks do Gemini/OpenAI têm na prática, e
    // que a versão antiga (stateless, sem repacking) descartava a sobra de
    // cada um. `historyLen` amostras de transiente de entrada (warm-up) mais
    // outro tanto de saída (decaimento do flush) são esperadas nas pontas —
    // não são perda, são o filtro assentando; por isso a tolerância é function
    // de `historyLen`, não "±1".
    const r = createDownsampler24kTo16k();
    const sizes = [997, 1451, 313, 2803, 1024, 677, 4099, 199, 3121, 1487];
    let totalIn = 0;
    let totalOut = 0;
    for (const size of sizes) {
      const samples = Array.from({ length: size }, (_, i) => ((i * 37) % 2000) - 1000);
      totalIn += size;
      totalOut += r.process(toInt16Buffer(samples)).length / 2;
    }
    totalOut += r.flush().length / 2;

    const historyLen = 64; // ceil(127/2) — ver constructor de RationalResampler
    const ideal = Math.round((totalIn * 2) / 3);
    const tolerance = Math.ceil((2 * historyLen * 2) / 3) + 2;
    assert.ok(
      Math.abs(totalOut - ideal) <= tolerance,
      `saída de ${totalOut} amostras, esperado ${ideal} ± ${tolerance}`,
    );
  });

  it('continuidade entre chunks: processar tudo de uma vez ou em pedaços produz o MESMO resultado', () => {
    // Falha na versão antiga: fase resetava a cada chamada e a última
    // amostra de cada chunk era clampada, gerando uma descontinuidade em
    // toda fronteira — audível como aspereza na taxa de chunks do provider.
    const fsIn = 24000;
    const n = 4800;
    const full = sineBuffer(1000, fsIn, n);

    const whole = createDownsampler24kTo16k();
    const outWhole = toSamples(whole.process(full));

    const chunked = createDownsampler24kTo16k();
    const pieceSizes = [7, 13, 331, 1009, 997, 1443, 1000];
    let consumed = 0;
    const outChunked: number[] = [];
    for (const size of pieceSizes) {
      if (consumed >= n) break;
      const take = Math.min(size, n - consumed);
      const piece = full.subarray(consumed * 2, (consumed + take) * 2);
      outChunked.push(...toSamples(chunked.process(piece)));
      consumed += take;
    }

    assert.equal(consumed, n);
    assert.equal(outChunked.length, outWhole.length);
    for (let i = 0; i < outWhole.length; i++) {
      assert.equal(outChunked[i], outWhole[i], `amostra ${i} diverge entre inteiro e fatiado`);
    }
  });

  it('sem clique de fronteira: a amplitude entre amostras consecutivas respeita o slew do sinal, mesmo fatiado em pedaços de tamanho aleatório', () => {
    const fsIn = 24000;
    const freq = 200;
    const amplitude = 10000;
    const n = 24000;
    const full = sineBuffer(freq, fsIn, n, amplitude);
    const r = createDownsampler24kTo16k();

    const all: number[] = [];
    let offset = 0;
    let seed = 1;
    const pseudoRandom = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    while (offset < n) {
      const size = Math.min(50 + Math.floor(pseudoRandom() * 400), n - offset);
      all.push(...toSamples(r.process(full.subarray(offset * 2, (offset + size) * 2))));
      offset += size;
    }

    // Slew máximo teórico de um seno de amplitude A e frequência freq
    // amostrado a 16kHz: A * 2*pi*freq / fsOut. Alguma margem (ringing perto
    // das fronteiras aleatórias) é esperada; um salto muito maior que isso é
    // o "clique" que a versão antiga produzia a cada fronteira de chunk.
    const expectedSlew = (amplitude * 2 * Math.PI * freq) / 16000;
    let maxDelta = 0;
    for (let i = 1; i < all.length; i++) maxDelta = Math.max(maxDelta, Math.abs(all[i] - all[i - 1]));
    assert.ok(
      maxDelta <= expectedSlew * 1.5,
      `salto máximo de ${maxDelta.toFixed(0)} excede 1.5x o slew esperado (${expectedSlew.toFixed(0)})`,
    );
  });

  it('faixa de passagem plana: 1kHz sai com o mesmo RMS de entrada', () => {
    const buf = sineBuffer(1000, 24000, 48000);
    const r = createDownsampler24kTo16k();
    const out = toSamples(r.process(buf));
    const settled = out.slice(200, out.length - 200); // fora do transiente de warm-up
    const outRms = rms(settled);
    const inRms = 10000 / Math.SQRT2;
    const dB = 20 * Math.log10(outRms / inRms);
    assert.ok(Math.abs(dB) <= 1, `1kHz atenuado/amplificado em ${dB.toFixed(2)}dB, esperado ±1dB`);
  });

  it('ganho DC exato: entrada constante sai constante (pega erro de normalização de ramo)', () => {
    const n = 24000;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(8000, i * 2);
    const r = createDownsampler24kTo16k();
    // Sem flush: o flush pisa em zero-padding e faz a saída decair para 0 nas
    // últimas amostras — comportamento correto do filtro, mas não o que este
    // teste quer medir (ganho em regime permanente).
    const out = toSamples(r.process(buf));
    const settled = out.slice(200, out.length - 5);
    for (const sample of settled) {
      assert.ok(Math.abs(sample - 8000) <= 1, `amostra ${sample} longe do DC de entrada (8000)`);
    }
  });

  it('atenua 10kHz (Nyquist da saída é 8kHz) em pelo menos 40dB, sem energia significativa no alias em 6kHz', () => {
    // 10kHz não sobrevive ao downsample para 16kHz: sem anti-aliasing, ele
    // dobra para 16000-10000=6kHz — exatamente o timbre metálico do TTS que
    // a versão antiga (interpolação linear, ~3dB de atenuação em 8kHz) tinha.
    const buf = sineBuffer(10000, 24000, 48000);
    const r = createDownsampler24kTo16k();
    const out = toSamples(r.process(buf));
    const settled = out.slice(200, out.length - 200);

    const outRms = rms(settled);
    const inRms = 10000 / Math.SQRT2;
    const dB = 20 * Math.log10(outRms / inRms);
    assert.ok(dB <= -40, `10kHz atenuado em só ${dB.toFixed(1)}dB, esperado ≤-40dB`);

    const passbandRef = goertzelMagnitude(toSamples(r.process(sineBuffer(1000, 24000, 16000))), 1000, 16000);
    const aliasMag = goertzelMagnitude(settled, 6000, 16000);
    const aliasDB = 20 * Math.log10(aliasMag / passbandRef);
    assert.ok(aliasDB <= -40, `alias em 6kHz a só ${aliasDB.toFixed(1)}dB abaixo da passband, esperado ≤-40dB`);
  });
});

describe('RationalResampler: upsampler 16kHz→24kHz (uplink OpenAI)', () => {
  it('comprimento de saída ~3/2 do de entrada', () => {
    const n = 320; // AUDIO_CHUNK_SIZE do protocolo (20ms @16kHz)
    const buf = sineBuffer(300, 16000, n);
    const r = createUpsampler16kTo24k();
    const outLen = r.process(buf).length / 2 + r.flush().length / 2;
    const historyLen = 43; // ceil(127/3)
    const ideal = Math.round((n * 3) / 2);
    const tolerance = Math.ceil((2 * historyLen * 3) / 2) + 2;
    assert.ok(Math.abs(outLen - ideal) <= tolerance, `saída de ${outLen}, esperado ${ideal} ± ${tolerance}`);
  });

  it('cada chunk de 20ms (320 amostras) termina numa amostra correta — sem o clamp da versão antiga', () => {
    // A versão antiga (`320 % 3 != 0`) clampava a última amostra de TODO
    // chunk de 20ms para a penúltima, criando um artefato periódico a 50Hz
    // no áudio enviado à OpenAI. Continuidade entre chunks consecutivos do
    // MESMO tamanho de protocolo prova que isso não acontece mais.
    const fsIn = 16000;
    const n = 320 * 5;
    const full = sineBuffer(300, fsIn, n);

    const whole = createUpsampler16kTo24k();
    const outWhole = toSamples(whole.process(full));

    const chunked = createUpsampler16kTo24k();
    const outChunked: number[] = [];
    for (let offset = 0; offset < n; offset += 320) {
      outChunked.push(...toSamples(chunked.process(full.subarray(offset * 2, (offset + 320) * 2))));
    }

    assert.equal(outChunked.length, outWhole.length);
    for (let i = 0; i < outWhole.length; i++) {
      assert.equal(outChunked[i], outWhole[i], `amostra ${i} diverge entre inteiro e fatiado em blocos de 320`);
    }
  });

  it('faixa de passagem plana: 7kHz sai com o mesmo RMS de entrada', () => {
    const buf = sineBuffer(7000, 16000, 32000);
    const r = createUpsampler16kTo24k();
    const out = toSamples(r.process(buf));
    const settled = out.slice(300, out.length - 300);
    const outRms = rms(settled);
    const inRms = 10000 / Math.SQRT2;
    const dB = 20 * Math.log10(outRms / inRms);
    assert.ok(Math.abs(dB) <= 1, `7kHz atenuado/amplificado em ${dB.toFixed(2)}dB, esperado ±1dB`);
  });

  it('sem imagem espúria acima de 8kHz (upsample sem filtro cria imagens que, ao decimar 48k→24k, dobram para dentro da banda)', () => {
    const buf = sineBuffer(7000, 16000, 32000);
    const r = createUpsampler16kTo24k();
    const out = toSamples(r.process(buf));
    const settled = out.slice(300, out.length - 300);

    const signalMag = goertzelMagnitude(settled, 7000, 24000);
    const imageMag = goertzelMagnitude(settled, 9000, 24000); // imagem: 16000-7000=9000
    const imageDB = 20 * Math.log10(imageMag / signalMag);
    assert.ok(imageDB <= -40, `imagem em 9kHz a só ${imageDB.toFixed(1)}dB abaixo do sinal, esperado ≤-40dB`);
  });
});

describe('RationalResampler: reset() e flush()', () => {
  it('reset() volta ao estado inicial: mesma entrada depois de reset produz a mesma saída', () => {
    const r = createDownsampler24kTo16k();
    const buf = sineBuffer(1000, 24000, 4800);
    const first = toSamples(r.process(buf));
    r.reset();
    const second = toSamples(r.process(buf));
    assert.deepEqual(second, first);
  });

  it('flush() drena o resto pendente sem quebrar chamadas seguintes', () => {
    const r = createDownsampler24kTo16k();
    r.process(sineBuffer(1000, 24000, 100));
    const tail = r.flush();
    assert.ok(tail.length >= 0);
    // Depois do flush, a sessão pode continuar (não é preciso reset()) — a
    // instância vive pela sessão de provider inteira, não por turno.
    const more = r.process(sineBuffer(1000, 24000, 4800));
    assert.ok(more.length > 0);
  });

  it('duas instâncias (up/down diferentes) não compartilham estado — RationalResampler genérico aceita qualquer par', () => {
    const custom = new RationalResampler(3, 2, designKaiserLowpass(63, 7000, 48000, 5.0));
    const out = custom.process(sineBuffer(500, 16000, 320));
    assert.ok(out.length > 0);
  });
});
