// Gera assets/icon.ico — ícone do app usado pelo instalador NSIS (electron-builder)
// e pela barra de tarefas do app empacotado. Distinto dos ícones de bandeja
// (tray-*.png, pequenos demais e no formato errado para um instalador): mesmo
// desenho de disco+anel de generate-icons.mjs, na cor "idle", em quatro
// resoluções dentro de um único .ico multi-imagem.
//
// Node puro — sem sharp/png-to-ico — mesma razão de generate-icons.mjs: evitar
// addon nativo. O formato ICO moderno (Vista+) aceita frames PNG crus dentro do
// container, então basta empacotar os PNGs que já sabemos gerar.
//
// Rode `npm run icons` (que chama este script também) depois de mexer na
// paleta ou na geometria em png.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawDisc, encodePng } from './png.mjs';

// Mesma cor de tray-idle.png (generate-icons.mjs) — o app "descansando" é a
// primeira coisa que o usuário vê no instalador/barra de tarefas.
const IDLE_COLOR = [0x5a, 0x6b, 0x8c];

// ICO padrão do Windows: 16/32/48 para ícones de UI, 256 para o instalador/
// Explorer em "ícones grandes". 0 no cabeçalho de largura/altura = 256
// (convenção do formato, não um bug).
const SIZES = [16, 32, 48, 256];

/** Monta um .ico multi-imagem com frames PNG (suportado desde o Windows Vista). */
function encodeIco(pngsBySize) {
  const count = pngsBySize.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (icon)
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  const dataBufs = [];
  let offset = 6 + 16 * count;

  pngsBySize.forEach(({ size, png }, i) => {
    const e = i * 16;
    entries[e] = size >= 256 ? 0 : size; // width (0 = 256)
    entries[e + 1] = size >= 256 ? 0 : size; // height (0 = 256)
    entries[e + 2] = 0; // color count (0 = sem paleta, >=8bpp)
    entries[e + 3] = 0; // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(png.length, e + 8); // tamanho dos dados
    entries.writeUInt32LE(offset, e + 12); // offset dos dados
    dataBufs.push(png);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...dataBufs]);
}

const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(assetsDir, { recursive: true });

const frames = SIZES.map((size) => ({ size, png: encodePng(drawDisc(size, IDLE_COLOR), size) }));
const ico = encodeIco(frames);
const outPath = join(assetsDir, 'icon.ico');
writeFileSync(outPath, ico);
console.log(`[icon] icon.ico (${SIZES.join('/')}px, ${ico.length} bytes)`);
