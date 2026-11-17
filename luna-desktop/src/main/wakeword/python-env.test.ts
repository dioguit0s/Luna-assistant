import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  REQUIREMENTS_MARKER,
  ensureSidecarPython,
  invalidateSidecarVenv,
  venvPythonPath,
  type ProvisionStage,
  type RunResult,
} from './python-env.js';

/** Runner falso: registra as chamadas e "cria" o python do venv no `-m venv`. */
function fakeRunner(opts: { available?: string[]; pipCode?: number } = {}) {
  const calls: string[] = [];
  const available = new Set(opts.available ?? ['py -3.14']);
  const run = async (command: string, args: string[]): Promise<RunResult> => {
    calls.push([command, ...args].join(' '));
    if (args.at(-1) === '--version') {
      const name = [command, ...args.slice(0, -1)].join(' ');
      return available.has(name) ? { code: 0, output: 'Python 3.14.4' } : { code: null, output: 'ENOENT' };
    }
    const venvIdx = args.indexOf('venv');
    if (args[venvIdx - 1] === '-m' && venvIdx >= 0) {
      const python = venvPythonPath(args[venvIdx + 1]);
      mkdirSync(dirname(python), { recursive: true });
      writeFileSync(python, '');
      return { code: 0, output: '' };
    }
    if (args.includes('pip')) {
      return opts.pipCode ? { code: opts.pipCode, output: 'linha 1\nERROR: No matching distribution found' } : { code: 0, output: '' };
    }
    return { code: 1, output: 'inesperado' };
  };
  return { run, calls };
}

describe('ensureSidecarPython', () => {
  let dir: string;
  let venvDir: string;
  let requirementsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'luna-venv-'));
    venvDir = join(dir, 'wakeword-venv');
    requirementsPath = join(dir, 'requirements.txt');
    writeFileSync(requirementsPath, 'numpy>=2\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cria o venv, instala e grava o marcador na primeira vez', async () => {
    const { run, calls } = fakeRunner();
    const stages: ProvisionStage[] = [];
    const python = await ensureSidecarPython({ venvDir, requirementsPath, run, onProvision: (s) => stages.push(s) });

    assert.equal(python, venvPythonPath(venvDir));
    assert.deepEqual(stages, ['create-venv', 'install-requirements']);
    assert.ok(calls.some((c) => c.startsWith(`py -3.14 -m venv`)));
    assert.ok(calls.some((c) => c.includes('pip install') && c.endsWith(requirementsPath)));
    assert.match(readFileSync(join(venvDir, REQUIREMENTS_MARKER), 'utf8'), /^[0-9a-f]{64}$/);
  });

  it('venv pronto e requirements igual: não roda nada', async () => {
    await ensureSidecarPython({ venvDir, requirementsPath, run: fakeRunner().run });
    const { run, calls } = fakeRunner();
    await ensureSidecarPython({ venvDir, requirementsPath, run });
    assert.deepEqual(calls, []);
  });

  it('requirements mudou: reinstala sem recriar o venv', async () => {
    await ensureSidecarPython({ venvDir, requirementsPath, run: fakeRunner().run });
    writeFileSync(requirementsPath, 'numpy>=2\nsoundfile>=0.13\n');
    const { run, calls } = fakeRunner();
    const stages: ProvisionStage[] = [];
    await ensureSidecarPython({ venvDir, requirementsPath, run, onProvision: (s) => stages.push(s) });
    assert.deepEqual(stages, ['install-requirements']);
    assert.ok(!calls.some((c) => c.includes('-m venv')));
  });

  it('cai para o próximo Python base quando o preferido não existe', async () => {
    const { run, calls } = fakeRunner({ available: ['python'] });
    await ensureSidecarPython({ venvDir, requirementsPath, run });
    assert.ok(calls.some((c) => c.startsWith('python -m venv')));
  });

  it('sem Python nenhum: erro explicando o que instalar', async () => {
    const { run } = fakeRunner({ available: [] });
    await assert.rejects(ensureSidecarPython({ venvDir, requirementsPath, run }), /Python 3 não encontrado/);
  });

  it('pip falhou: erro com o fim da saída e sem marcador, para tentar de novo', async () => {
    const { run } = fakeRunner({ pipCode: 1 });
    await assert.rejects(ensureSidecarPython({ venvDir, requirementsPath, run }), /No matching distribution/);
    assert.throws(() => readFileSync(join(venvDir, REQUIREMENTS_MARKER)));

    const retry = fakeRunner();
    await ensureSidecarPython({ venvDir, requirementsPath, run: retry.run });
    assert.ok(retry.calls.some((c) => c.includes('pip install')));
    // Nunca ficou pronto (sem marcador): pode ter sido o Python base errado — recria do zero.
    assert.ok(retry.calls.some((c) => c.includes('-m venv')));
  });

  it('venv com python mas sem marcador (criação interrompida) é recriado do zero', async () => {
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, '');
    writeFileSync(join(venvDir, 'lixo-da-criacao-anterior'), '');

    const { run, calls } = fakeRunner();
    await ensureSidecarPython({ venvDir, requirementsPath, run });
    assert.ok(calls.some((c) => c.includes('-m venv')));
    assert.equal(existsSync(join(venvDir, 'lixo-da-criacao-anterior')), false);
  });

  it('invalidateSidecarVenv força recriar um venv que estava pronto', async () => {
    await ensureSidecarPython({ venvDir, requirementsPath, run: fakeRunner().run });
    invalidateSidecarVenv(venvDir);
    const { run, calls } = fakeRunner();
    await ensureSidecarPython({ venvDir, requirementsPath, run });
    assert.ok(calls.some((c) => c.includes('-m venv')));
  });

  it('cancelado no meio: rejeita e não chega ao pip', async () => {
    const abort = new AbortController();
    const { run, calls } = fakeRunner();
    const cancelling = async (command: string, args: string[]): Promise<RunResult> => {
      const result = await run(command, args);
      if (args.includes('venv')) abort.abort();
      return result;
    };
    await assert.rejects(
      ensureSidecarPython({ venvDir, requirementsPath, run: cancelling, signal: abort.signal }),
      /cancelada/,
    );
    assert.ok(!calls.some((c) => c.includes('pip install')));
    assert.throws(() => readFileSync(join(venvDir, REQUIREMENTS_MARKER)));
  });
});
