// Gera os ícones de bandeja em assets/ — um PNG por estado, em três escalas.
//
// Por que um gerador em vez de arquivos desenhados à mão: o repositório não tem
// nenhum asset de imagem e não queremos trazer dependência de rasterização
// (sharp e afins são addons nativos — exatamente o que o plano do luna-desktop
// evita). Node puro emite PNG sem esforço: zlib comprime, o resto é cabeçalho.
//
// Os PNGs resultantes são commitados. Rode `npm run icons` depois de mexer na
// paleta ou na geometria.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paleta por estado. O firmware só tem LED aceso/apagado (StatusLed.cpp), então
// não há cores para espelhar — esta paleta nasce aqui e é a fonte da verdade.
const PALETTE = {
  idle: [0x5a, 0x6b, 0x8c], // cinza-azulado apagado — esperando "Hey Luna"
  listening: [0x2e, 0x8b, 0xff], // azul vivo — capturando e enviando
  thinking: [0xf5, 0xa6, 0x23], // âmbar — janela de TTFAB
  speaking: [0x2e, 0xcc, 0x71], // verde — Luna falando
  error: [0xe5, 0x48, 0x4d], // vermelho — falha de auth/conexão
};

// O Electron escolhe a representação pelo sufixo do arquivo conforme o DPI.
const SCALES = [
  [16, ''],
  [24, '@1.5x'],
  [32, '@2x'],
];

const SUPERSAMPLE = 4; // antialiasing: um disco de 16px sem isso fica serrilhado
const RING_ALPHA = 217; // ~85% — o anel branco garante contraste na barra clara

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** Monta um chunk PNG: length + type + data + crc(type+data). */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Codifica RGBA cru (sem alpha pré-multiplicado) em um PNG de 8 bits. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Cada scanline leva um byte de filtro à frente; 0 = sem filtro.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Disco preenchido na cor do estado, com anel branco externo. */
function drawDisc(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const rOuter = size * 0.46;
  const rInner = size * 0.38;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Média ponderada por alpha das amostras: soma em alpha pré-multiplicado
      // e desfaz a multiplicação no fim, senão a borda escurece.
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE - center;
          const py = y + (sy + 0.5) / SUPERSAMPLE - center;
          const dist = Math.sqrt(px * px + py * py);

          if (dist <= rInner) {
            sumA += 255;
            sumR += r * 255;
            sumG += g * 255;
            sumB += b * 255;
          } else if (dist <= rOuter) {
            sumA += RING_ALPHA;
            sumR += 255 * RING_ALPHA;
            sumG += 255 * RING_ALPHA;
            sumB += 255 * RING_ALPHA;
          }
        }
      }

      const offset = (y * size + x) * 4;
      if (sumA > 0) {
        rgba[offset] = Math.round(sumR / sumA);
        rgba[offset + 1] = Math.round(sumG / sumA);
        rgba[offset + 2] = Math.round(sumB / sumA);
        rgba[offset + 3] = Math.round(sumA / samples);
      }
    }
  }

  return rgba;
}

// fileURLToPath e não URL.pathname: no Windows o pathname vem com barra à
// frente e espaços percent-encoded ("Luna%20assistant").
const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(assetsDir, { recursive: true });

for (const [state, color] of Object.entries(PALETTE)) {
  for (const [size, suffix] of SCALES) {
    const name = `tray-${state}${suffix}.png`;
    const png = encodePng(drawDisc(size, color), size);
    writeFileSync(join(assetsDir, name), png);
    console.log(`[icons] ${name} (${size}x${size}, ${png.length} bytes)`);
  }
}
