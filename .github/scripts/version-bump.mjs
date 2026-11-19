#!/usr/bin/env node
// Sobe a versão de cada parte do monorepo que a PR alterou (workflow
// version-bump.yml). Sem dependências: só node e git.
//
//   node .github/scripts/version-bump.mjs --base <sha da main> [--head HEAD]
//        [--title "<título da PR>"] [--labels "bump:minor,..."] [--dry-run]
//
// Por parte (firmware, server, desktop):
//   1. Mudou? Diff de merge-base(base, head)..head no diretório, ignorando
//      Markdown e as próprias linhas de versão (senão o commit do bump contaria
//      como mudança e subiria de novo).
//   2. Quanto subir? Label `bump:major|minor|patch` manda; sem label, os
//      commits da PR que tocam a parte (Conventional Commits): `!`/BREAKING ->
//      major (minor enquanto a versão for 0.x), `feat` -> minor, resto -> patch.
//      `bump:skip` não sobe nada.
//   3. A partir de quê? A maior entre a versão na main e a última tag estável
//      da parte (fw-v*), para não reusar uma versão já publicada.
//   4. Só escreve se a versão da PR for menor que a calculada: subir à mão para
//      mais (ou para um -rc) é respeitado, e rodar de novo não sobe de novo.
//
// Imprime um JSON por parte alterada e, com GITHUB_OUTPUT, `changed=` e
// `summary=` para o workflow montar a mensagem do commit.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- semver

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function formatVersion({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`;
}

/** <0, 0, >0. Pré-release é menor que a mesma versão estável (0.7.0-rc.1 < 0.7.0). */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function bumpVersion(v, kind) {
  const p = typeof v === 'string' ? parseVersion(v) : v;
  if (kind === 'major') return formatVersion({ major: p.major + 1, minor: 0, patch: 0, pre: null });
  if (kind === 'minor') return formatVersion({ major: p.major, minor: p.minor + 1, patch: 0, pre: null });
  // Patch de uma pré-release fecha a própria release (0.7.0-rc.1 -> 0.7.0).
  if (p.pre) return formatVersion({ ...p, pre: null });
  return formatVersion({ ...p, patch: p.patch + 1, pre: null });
}

// ---------------------------------------------------------- tipo de bump

const RANK = { patch: 1, minor: 2, major: 3 };
const BUMP_LABEL = /^bump:(major|minor|patch|skip)$/;

/** Label de bump, ou null. Mais de uma: vale a maior (skip só sozinho). */
export function bumpFromLabels(labels) {
  const kinds = labels.map((l) => BUMP_LABEL.exec(l.trim())?.[1]).filter(Boolean);
  const real = kinds.filter((k) => k !== 'skip');
  if (real.length) return real.sort((a, b) => RANK[b] - RANK[a])[0];
  return kinds.includes('skip') ? 'skip' : null;
}

/** Tipo de bump a partir de mensagens de commit (assunto + corpo). */
export function bumpFromMessages(messages) {
  let kind = 'patch';
  for (const msg of messages) {
    const subject = msg.split('\n', 1)[0];
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(msg)) return 'major';
    if (/^feat(\([^)]*\))?:/.test(subject)) kind = 'minor';
  }
  return kind;
}

/** 0.x: mudança incompatível sobe o minor (convenção do semver para 0.y.z). */
export function effectiveKind(kind, base) {
  return kind === 'major' && parseVersion(base).major === 0 ? 'minor' : kind;
}

// ------------------------------------------------------ detecção de mudança

/**
 * Arquivos de `git diff -U0` com mudança que conta. `ignoreLine(file, line)`
 * descarta linhas (a de versão); arquivo sem nenhuma linha +/- (binário,
 * rename, modo) conta como mudança.
 */
export function changedFiles(diffText, { ignoreFile = () => false, ignoreLine = () => false } = {}) {
  const out = [];
  let file = null;
  let sawLine = false;
  let counts = false;
  const flush = () => {
    if (file !== null && !ignoreFile(file) && (counts || !sawLine)) out.push(file);
  };
  for (const line of diffText.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      file = header[2];
      sawLine = false;
      counts = false;
      continue;
    }
    if (file === null || line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      sawLine = true;
      if (!ignoreLine(file, line.slice(1))) counts = true;
    }
  }
  flush();
  return out;
}

// ------------------------------------------------------------- as partes

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

const INI_VERSION = /^(custom_fw_version\s*=\s*)(\S+)/m;

function packageJsonPart(name, dir) {
  return {
    name,
    dir,
    versionFiles: ['package.json', 'package-lock.json'],
    isVersionLine: (file, line) =>
      /(^|\/)package(-lock)?\.json$/.test(file) && /^\s*"version":\s*"[^"]*",?\s*$/.test(line),
    read: (root) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).version,
    readAt: (git, rev) => JSON.parse(git('show', `${rev}:${dir}/package.json`)).version,
    write: (root, version) => {
      for (const f of ['package.json', 'package-lock.json']) {
        const path = join(root, dir, f);
        let text;
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          continue;
        }
        const eol = eolOf(text);
        const json = JSON.parse(text);
        json.version = version;
        if (json.packages?.['']) json.packages[''].version = version;
        writeFileSync(path, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
      }
    },
  };
}

export const PARTS = [
  {
    name: 'firmware',
    dir: 'luna-firmware',
    tagPrefix: 'fw-v',
    versionFiles: ['platformio.ini'],
    // No .ini, comentário e linha em branco também não contam: não mudam o binário.
    isVersionLine: (file, line) =>
      file.endsWith('platformio.ini') && /^(custom_fw_version\s*=|\s*[;#]|\s*$)/.test(line),
    read: (root) => INI_VERSION.exec(readFileSync(join(root, 'luna-firmware/platformio.ini'), 'utf8'))?.[2],
    readAt: (git, rev) => INI_VERSION.exec(git('show', `${rev}:luna-firmware/platformio.ini`))?.[2],
    write: (root, version) => {
      const path = join(root, 'luna-firmware/platformio.ini');
      const text = readFileSync(path, 'utf8');
      if (!INI_VERSION.test(text)) throw new Error('custom_fw_version não encontrado no platformio.ini');
      writeFileSync(path, text.replace(INI_VERSION, `$1${version}`));
    },
  },
  packageJsonPart('server', 'luna-server'),
  packageJsonPart('desktop', 'luna-desktop'),
];

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const args = { head: 'HEAD', title: '', labels: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--title') args.title = argv[++i] ?? '';
    else if (a === '--labels') args.labels = argv[++i] ?? '';
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!args.base) throw new Error('--base é obrigatório');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  const mergeBase = git('merge-base', args.base, args.head).trim();
  const label = bumpFromLabels(args.labels.split(',').filter(Boolean));
  const results = [];

  for (const part of PARTS) {
    const diff = git('diff', '-U0', '--no-color', '--no-ext-diff', `${mergeBase}..${args.head}`, '--', part.dir);
    const files = changedFiles(diff, {
      ignoreFile: (f) => /\.md$/i.test(f),
      ignoreLine: part.isVersionLine,
    });
    if (files.length === 0) continue;

    const current = part.read(root);
    // Arquivo ou linha de versão ainda inexistente na main: parte nova, parte de 0.0.0.
    let onMain;
    try {
      onMain = part.readAt(git, args.base);
    } catch {
      onMain = undefined;
    }
    onMain ??= '0.0.0';
    if (!parseVersion(current) || !parseVersion(onMain)) {
      throw new Error(`${part.name}: versão ilegível (PR: ${current}, main: ${onMain})`);
    }

    let from = onMain;
    if (part.tagPrefix) {
      for (const tag of git('tag', '--list', `${part.tagPrefix}*`).split('\n').filter(Boolean)) {
        const v = parseVersion(tag.slice(part.tagPrefix.length));
        if (v && v.pre === null && compareVersions(v, from) > 0) from = formatVersion(v);
      }
    }

    // Sem label: commits da PR que tocam a parte (exceto o do próprio bump) e o título.
    let kind = label;
    if (!kind) {
      const log = git('log', '--no-merges', '--format=%B%x00', `${mergeBase}..${args.head}`, '--', part.dir);
      const messages = log
        .split('\0')
        .map((m) => m.trim())
        .filter((m) => m && !m.startsWith('chore(versão)'));
      kind = bumpFromMessages([args.title, ...messages].filter(Boolean));
    }

    const result = { part: part.name, files: files.length, main: onMain, base: from, current, kind };
    if (kind === 'skip') {
      results.push({ ...result, target: current, written: false });
      continue;
    }
    kind = effectiveKind(kind, from);
    const target = bumpVersion(from, kind);
    const written = compareVersions(current, target) < 0;
    if (written && !args.dryRun) part.write(root, target);
    results.push({ ...result, kind, target: written ? target : current, written });
  }

  for (const r of results) console.log(JSON.stringify(r));

  const changed = results.filter((r) => r.written);
  const summary = changed.map((r) => `${r.part} ${r.target}`).join(', ');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\nsummary=${summary}\n`);
  }
  if (!results.length) console.log('nenhuma parte versionada foi alterada');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`[version-bump] ${err.message}`);
    process.exit(1);
  }
}
