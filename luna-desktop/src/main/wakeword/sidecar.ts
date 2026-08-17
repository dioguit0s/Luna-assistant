// Lifecycle do sidecar Python de wake word (wakeword-sidecar/wake_sidecar.py
// --stdin, ver README nesse diretório): sobe o processo, alimenta PCM cru via
// stdin, parseia os eventos JSON de stdout (wakeword/protocol.ts), e reinicia
// sozinho com backoff se o processo cair — mesmo padrão de reconexão que
// LunaWsClient já usa para o WebSocket (ws/client.ts). Um crash do Python não
// deve derrubar o app de bandeja.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

import { parseWakewordLine, type WakewordEvent } from './protocol.js';

// De dist/main/wakeword/ sobe três níveis até a raiz do projeto — mesmo
// padrão de PROJECT_ROOT em config.ts / ASSETS_DIR em tray.ts, um nível mais
// fundo porque este módulo mora em src/main/wakeword/, não em src/main/.
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Empacotado (app.asar), o cálculo acima resolveria pra um caminho virtual
// dentro do asar que não existe no disco — o Python precisa de um diretório
// real pra rodar. electron-builder copia wakeword-sidecar/ (código-fonte, sem
// .venv/fixtures) pra fora do asar via extraResources (ver
// electron-builder.yml), acessível em process.resourcesPath. Em dev, mantém o
// caminho relativo ao monorepo de sempre.
const SIDECAR_DIR = app.isPackaged
  ? join(process.resourcesPath, 'wakeword-sidecar')
  : join(PROJECT_ROOT, 'wakeword-sidecar');
const DEFAULT_PYTHON_PATH = join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe');

// Em dev, wake_sidecar.py resolve seu próprio default (hey_luna_trained.tflite)
// relativo ao checkout do monorepo (luna-firmware/models/, fora de
// luna-desktop/) — não existe empacotado, porque só luna-desktop/ vai pro
// instalador. extraResources também copia os .tflite vendorizados pra
// SIDECAR_DIR/models/; aqui fixamos o caminho explícito só nesse caso, sem
// mudar o default do próprio script em dev.
const DEFAULT_MODEL_PATH = app.isPackaged
  ? join(SIDECAR_DIR, 'models', 'hey_luna_trained.tflite')
  : undefined;

const RESTART_BACKOFF_INITIAL_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
// Um evento `error` estruturado (modelo ausente, geometria incompatível) não
// se corrige sozinho — pula direto pro teto do backoff em vez de martelar a
// cada 1s. Mesmo racional do AUTH_ERROR_BACKOFF_MS em ws/client.ts.
const FATAL_ERROR_BACKOFF_MS = RESTART_BACKOFF_MAX_MS;

export interface WakewordSidecarOptions {
  /** Default: wakeword-sidecar/.venv/Scripts/python.exe */
  pythonPath?: string;
  /**
   * --model — omitido usa hey_luna_trained.tflite: em dev, o default do
   * próprio wake_sidecar.py (relativo ao monorepo); empacotado, DEFAULT_MODEL_PATH
   * (resources/wakeword-sidecar/models/, ver comentário acima).
   */
  model?: string;
  /** --threshold — omitido usa o default do próprio wake_sidecar.py (0.97) */
  threshold?: number;
}

export interface WakewordSidecarEvents {
  ready: (info: Extract<WakewordEvent, { event: 'ready' }>) => void;
  wake: (info: Extract<WakewordEvent, { event: 'wake' }>) => void;
  crashed: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  restartScheduled: (delayMs: number) => void;
  fatalError: (message: string) => void;
}

export declare interface WakewordSidecar {
  on<K extends keyof WakewordSidecarEvents>(event: K, listener: WakewordSidecarEvents[K]): this;
  emit<K extends keyof WakewordSidecarEvents>(
    event: K,
    ...args: Parameters<WakewordSidecarEvents[K]>
  ): boolean;
}

export class WakewordSidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = RESTART_BACKOFF_INITIAL_MS;
  private sawFatalError = false;

  constructor(private readonly opts: WakewordSidecarOptions = {}) {
    super();
  }

  /** Inicia o processo (e o ciclo de restart automático até stop()). */
  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  /** Encerra de vez — usado no app.quit(). Não reinicia depois disso. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }

  /** Escreve PCM16LE cru no stdin do sidecar. No-op se o processo não estiver de pé. */
  feed(pcm: Buffer): void {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(pcm);
  }

  private spawnChild(): void {
    const pythonPath = this.opts.pythonPath ?? DEFAULT_PYTHON_PATH;
    const model = this.opts.model ?? DEFAULT_MODEL_PATH;
    const args = ['wake_sidecar.py', '--stdin'];
    if (model) args.push('--model', model);
    if (this.opts.threshold !== undefined) args.push('--threshold', String(this.opts.threshold));

    // windowsHide: sem isso, cada (re)início do sidecar pisca uma janela de
    // console preta — python.exe é um console app, e o app de bandeja não tem
    // console próprio para herdar.
    const child = spawn(pythonPath, args, { cwd: SIDECAR_DIR, windowsHide: true });
    this.child = child;
    this.sawFatalError = false;

    child.stdout.setEncoding('utf8');
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));

    // O sidecar já faz sys.stderr.reconfigure(encoding="utf-8") do lado
    // Python — o console do Windows tende a cp1252/cp850, então o lado Node
    // precisa decodificar como UTF-8 explicitamente também, senão acentos em
    // pt-BR (ex. "inferências", "detecção") saem como lixo no log.
    child.stderr.setEncoding('utf8');
    createInterface({ input: child.stderr }).on('line', (line) => {
      console.warn(`[wakeword-sidecar] ${line}`);
    });

    child.on('error', (err) => {
      // Falha do próprio spawn (ex. python.exe não existe porque o venv não
      // foi criado) — não passa por 'exit', precisa de handler próprio.
      console.error(`[wakeword-sidecar] falha ao iniciar processo: ${err.message}`);
      this.emit('fatalError', err.message);
      this.child = null;
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // já substituído por um restart — eco do processo antigo
      this.child = null;
      if (this.stopped) return;
      console.warn(`[wakeword-sidecar] processo saiu (code=${code} signal=${signal})`);
      this.emit('crashed', { code, signal });
      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    const event = parseWakewordLine(line);
    if (!event) {
      console.warn(`[wakeword-sidecar] linha inesperada em stdout: ${line}`);
      return;
    }

    switch (event.event) {
      case 'ready':
        this.backoffMs = RESTART_BACKOFF_INITIAL_MS; // processo saudável reseta o backoff
        this.emit('ready', event);
        break;
      case 'wake':
        this.emit('wake', event);
        break;
      case 'error':
        // Pode chegar como a própria primeira linha (modelo ausente/geometria
        // inválida) — o processo sai com exit code 2 logo em seguida, que
        // também dispara scheduleRestart() via o handler de 'exit'.
        this.sawFatalError = true;
        console.error(`[wakeword-sidecar] erro: ${event.message}`);
        this.emit('fatalError', event.message);
        break;
      case 'eof':
        // Só acontece se algo fechar o stdin do processo — não esperado em
        // operação normal (feed() nunca chama end()); sem ação própria.
        break;
    }
  }

  private scheduleRestart(): void {
    if (this.stopped) return;

    const delay = this.sawFatalError ? FATAL_ERROR_BACKOFF_MS : this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);

    this.emit('restartScheduled', delay);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnChild();
    }, delay);
  }
}
