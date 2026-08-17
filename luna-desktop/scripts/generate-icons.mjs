// Gera os ícones de bandeja em assets/ — um PNG por estado, em três escalas.
//
// Por que um gerador em vez de arquivos desenhados à mão: o repositório não tem
// nenhum asset de imagem e não queremos trazer dependência de rasterização
// (sharp e afins são addons nativos — exatamente o que o plano do luna-desktop
// evita). Node puro emite PNG sem esforço: zlib comprime, o resto é cabeçalho.
//
// Os PNGs resultantes são commitados. Rode `npm run icons` depois de mexer na
// paleta ou na geometria (compartilhada com generate-app-icon.mjs via png.mjs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawDisc, encodePng } from './png.mjs';

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
