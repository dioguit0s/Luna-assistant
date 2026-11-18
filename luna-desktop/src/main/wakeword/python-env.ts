// Ambiente Python do sidecar de wake word no app empacotado.
//
// O instalador não leva o venv (v1 exige Python local, ver docs/luna-desktop.md),
// e o NSIS substitui a pasta de instalação inteira a cada atualização — um
// venv criado dentro de resources/ some na próxima reinstalação, e a wake word
// morre com "python.exe ENOENT". Por isso o venv mora no userData, que o
// instalador não toca, e o próprio app o cria (e reinstala as dependências
// quando o requirements.txt muda) em vez de depender de um passo manual.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunResult {
  code: number | null;
  output: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Mata o processo depois disso: `pip` pendurado em rede travada não pode prender a wake word. */
  timeoutMs?: number;
}

export type Runner = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const PROBE_TIMEOUT_MS = 15_000;
const VENV_TIMEOUT_MS = 2 * 60_000;
const PIP_TIMEOUT_MS = 10 * 60_000;

/** Python base para criar o venv, na ordem de preferência. */
export const BASE_PYTHON_CANDIDATES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // As wheels do requirements.txt (ai-edge-litert, pymicro-features) foram
  // validadas em 3.14 — ver wakeword-sidecar/README.md.
  ['py', ['-3.14']],
  ['py', ['-3']],
  ['python', []],
];

/**
 * Gravado no venv depois de um `pip install` bem-sucedido: hash do
 * requirements.txt. Ausente = o venv nunca ficou pronto (app fechado no meio
 * da criação, pip sem módulo, Python base errado) e é recriado do zero.
 */
export const REQUIREMENTS_MARKER = '.luna-requirements.sha256';

export function venvPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

export type ProvisionStage = 'create-venv' | 'install-requirements';

export interface EnsurePythonOptions {
  venvDir: string;
  requirementsPath: string;
  run?: Runner;
  candidates?: ReadonlyArray<readonly [string, readonly string[]]>;
  /** Avisado antes de cada etapa lenta — só quando de fato vai instalar algo. */
  onProvision?: (stage: ProvisionStage) => void;
  /** `stop()` do sidecar: mata o venv/pip em curso em vez de deixá-lo órfão. */
  signal?: AbortSignal;
}

/**
 * Força a próxima `ensureSidecarPython` a recriar o venv do zero — para quando
 * o python do venv existe mas não sobe (Python base desinstalado, site-packages
 * danificado), caso que o hash do requirements não enxerga.
 */
export function invalidateSidecarVenv(venvDir: string): void {
  rmSync(join(venvDir, REQUIREMENTS_MARKER), { force: true });
}

/** Últimas linhas da saída, para a mensagem de erro caber numa notificação. */
function tail(output: string, lines = 3): string {
  return output.trim().split(/\r?\n/).slice(-lines).join(' | ');
}

/**
 * Garante o venv do sidecar e devolve o caminho do python dele. Rápido quando
 * já está pronto (só confere o arquivo e o hash do requirements.txt).
 *
 * @throws Error com mensagem pronta para o usuário quando não há Python base
 *   ou quando o `pip install` falha (sem rede, wheel ausente). O marcador só é
 *   gravado no sucesso, então a próxima tentativa recomeça a instalação.
 */
export async function ensureSidecarPython(opts: EnsurePythonOptions): Promise<string> {
  const run = opts.run ?? defaultRunner;
  const python = venvPythonPath(opts.venvDir);
  const marker = join(opts.venvDir, REQUIREMENTS_MARKER);
  const requirementsHash = createHash('sha256').update(readFileSync(opts.requirementsPath)).digest('hex');

  const current = readMarker(marker);
  if (existsSync(python) && current === requirementsHash) return python;

  const { signal } = opts;
  const checkAborted = (): void => {
    if (signal?.aborted) throw new Error('preparação do ambiente Python cancelada');
  };

  // Sem marcador o venv nunca terminou de ficar pronto: o `python.exe` sai
  // antes do `ensurepip`, então "existe" não quer dizer "funciona". Do zero.
  if (current === null) rmSync(opts.venvDir, { recursive: true, force: true });

  if (!existsSync(python)) {
    const base = await findBasePython(run, opts.candidates ?? BASE_PYTHON_CANDIDATES, signal);
    checkAborted();
    if (!base) {
      throw new Error(
        'Python 3 não encontrado (py -3.14, py -3 ou python no PATH). Instale o Python 3.14 — o Luna tenta de novo sozinho.',
      );
    }
    opts.onProvision?.('create-venv');
    const created = await run(base[0], [...base[1], '-m', 'venv', opts.venvDir], {
      signal,
      timeoutMs: VENV_TIMEOUT_MS,
    });
    checkAborted();
    if (created.code !== 0 || !existsSync(python)) {
      throw new Error(`Falha ao criar o venv da wake word: ${tail(created.output) || `código ${created.code}`}`);
    }
  }

  opts.onProvision?.('install-requirements');
  const installed = await run(python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-q',
    '-r',
    opts.requirementsPath,
  ], { signal, timeoutMs: PIP_TIMEOUT_MS });
  checkAborted();
  if (installed.code !== 0) {
    throw new Error(
      `Falha ao instalar as dependências da wake word: ${tail(installed.output) || `código ${installed.code}`}`,
    );
  }
  writeFileSync(marker, requirementsHash, 'utf8');
  return python;
}

function readMarker(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

async function findBasePython(
  run: Runner,
  candidates: ReadonlyArray<readonly [string, readonly string[]]>,
  signal: AbortSignal | undefined,
): Promise<readonly [string, readonly string[]] | null> {
  for (const candidate of candidates) {
    if (signal?.aborted) return null;
    const probe = await run(candidate[0], [...candidate[1], '--version'], { signal, timeoutMs: PROBE_TIMEOUT_MS });
    if (probe.code === 0) return candidate;
  }
  return null;
}

const defaultRunner: Runner = (command, args, opts = {}) =>
  new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, output: 'cancelado' });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    // windowsHide: python/pip são console apps; sem isso piscam uma janela preta.
    const child = spawn(command, args, { windowsHide: true });
    // Sem isto o pip sobrevive ao app (no Windows o filho não morre com o pai)
    // e um segundo pip, do app reaberto, escreve no mesmo venv.
    const onAbort = (): void => {
      child.kill();
      finish({ code: null, output: 'cancelado' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish({ code: null, output: `${output}\ntempo esgotado (${Math.round(opts.timeoutMs! / 1000)} s)` });
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.stderr.on('data', (chunk: string) => (output += chunk));
    // Comando inexistente (sem `py` no PATH) cai aqui, não em 'close' com código.
    child.on('error', (err) => finish({ code: null, output: err.message }));
    child.on('close', (code) => finish({ code, output }));
  });
