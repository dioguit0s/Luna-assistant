// tsc não copia assets estáticos (.html) — só compila .ts. Sem este passo,
// dist/renderer/index.html nunca existe e loadFile() falha com "ENOENT" na
// primeira execução após um `npm run build` limpo.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Duas páginas: a janela oculta de captura (renderer/) e o painel de
// controle (panel/). Cada uma com seus estáticos e seus scripts clássicos.
const PAGES = [
  { dir: 'renderer', statics: ['index.html'], scripts: ['renderer.js', 'capture-worklet.js'] },
  { dir: 'panel', statics: ['index.html', 'panel.css'], scripts: ['panel.js'] },
];

for (const page of PAGES) {
  const src = join(root, 'src', page.dir);
  const dest = join(root, 'dist', page.dir);
  mkdirSync(dest, { recursive: true });

  for (const name of page.statics) {
    const from = join(src, name);
    if (!existsSync(from)) {
      console.warn(`[copy-renderer] aviso: ${from} não existe, pulando`);
      continue;
    }
    cpSync(from, join(dest, name));
    console.log(`[copy-renderer] ${name} -> dist/${page.dir}/`);
  }

  stripModuleSyntax(dest, page.scripts);
}

// Fontes do painel (docs/design-system-painel.md). Vão empacotadas porque a CSP
// do painel não permite rede — Google Fonts está fora de questão. Só o subset
// latin, que cobre o português; os glifos de caixa e bloco (╞═ ▣ █ ▁▂) caem no
// monoespaçado do sistema, como no design. A licença (OFL) viaja junto.
const FONTS = [
  { pkg: 'vt323', files: ['vt323-latin-400-normal.woff2'] },
  {
    pkg: 'ibm-plex-mono',
    files: [
      'ibm-plex-mono-latin-400-normal.woff2',
      'ibm-plex-mono-latin-500-normal.woff2',
      'ibm-plex-mono-latin-600-normal.woff2',
    ],
  },
];
const fontsDest = join(root, 'dist', 'panel', 'fonts');
mkdirSync(fontsDest, { recursive: true });
for (const font of FONTS) {
  const base = join(root, 'node_modules', '@fontsource', font.pkg);
  for (const file of font.files) {
    const from = join(base, 'files', file);
    if (!existsSync(from)) {
      console.error(`[copy-renderer] ERRO: fonte ${from} não existe — rode npm install.`);
      process.exit(1);
    }
    cpSync(from, join(fontsDest, file));
  }
  cpSync(join(base, 'LICENSE'), join(fontsDest, `${font.pkg}-LICENSE.txt`));
  console.log(`[copy-renderer] fonte ${font.pkg} -> dist/panel/fonts/`);
}

// renderer.ts e capture-worklet.ts são escritos de propósito sem import/export
// (ver comentário no topo de renderer.ts) para carregar como <script src="...">
// clássico via file://, sem a checagem estrita de MIME/CORS que Chromium
// aplica a `type="module"`. Mas o `declare global` que aumenta `Window` exige
// que o TS trate o arquivo como módulo, e sob "module":"NodeNext" isso faz o
// tsc emitir um `export {};` sozinho no fim do JS compilado — um `export`
// fora de um <script type="module"> é SyntaxError em runtime. Remove essa
// linha aqui, depois do tsc, em vez de abrir mão do declare global.
function stripModuleSyntax(dest, files) {
  for (const file of files) {
    const path = join(dest, file);
    if (!existsSync(path)) {
      console.warn(`[copy-renderer] aviso: ${path} não existe (rode tsc antes), pulando`);
      continue;
    }
    const original = readFileSync(path, 'utf8');
    const stripped = original.replace(/\n?export\s*\{\s*\};?\s*$/, '\n');
    if (stripped !== original) {
      writeFileSync(path, stripped, 'utf8');
      console.log(`[copy-renderer] removido "export {};" de ${file}`);
    }

    // Falha alto, não silencioso: se sobrar QUALQUER import/export (a regex
    // acima não bateu, ou o tsc passou a emitir de outro jeito), o arquivo vai
    // dar SyntaxError em runtime como <script> clássico — e como isso roda
    // dentro da janela oculta, o único sintoma visível seria "captura nunca
    // fica pronta", sem log de erro nenhum (quebra antes do try/catch do
    // renderer.ts rodar). Melhor quebrar o build agora do que isso depois.
    if (/^\s*(import|export)\b/m.test(stripped)) {
      console.error(
        `[copy-renderer] ERRO: ${file} ainda contém import/export depois do strip — ` +
          'vai quebrar como <script> clássico via file://. O tsc deve ter mudado a ' +
          'forma de emissão; ajuste a regex em scripts/copy-renderer.mjs.',
      );
      process.exit(1);
    }
  }
}
