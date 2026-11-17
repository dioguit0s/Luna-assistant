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
import { ensureSidecarPython, invalidateSidecarVenv, type ProvisionStage } from './python-env.js';

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
// Em dev, o venv do checkout (criado à mão, ver wakeword-sidecar/README.md).
// Empacotado, o venv mora no userData e é criado pelo próprio app — ver
// python-env.ts para o porquê (o NSIS apaga resources/ a cada reinstalação).
const DEV_PYTHON_PATH = join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe');

// Em dev, wake_sidecar.py resolve seu próprio default (hey_luna_ptbr_v2.tflite)
// relativo ao checkout do monorepo (luna-firmware/models/, fora de
// luna-desktop/) — não existe empacotado, porque só luna-desktop/ vai pro
// instalador. extraResources também copia os .tflite vendorizados pra
// SIDECAR_DIR/models/; aqui fixamos o caminho explícito só nesse caso, sem
// mudar o default do próprio script em dev.
const DEFAULT_MODEL_PATH = app.isPackaged
  ? join(SIDECAR_DIR, 'models', 'hey_luna_ptbr_v2.tflite')
  : undefined;

const RESTART_BACKOFF_INITIAL_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
// Um evento `error` estruturado (modelo ausente, geometria incompatível) não
// se corrige sozinho — pula direto pro teto do backoff em vez de martelar a
// cada 1s. Mesmo racional do AUTH_ERROR_BACKOFF_MS em ws/client.ts.
const FATAL_ERROR_BACKOFF_MS = RESTART_BACKOFF_MAX_MS;
// Preparação do venv que falhou (sem Python, sem rede): cada nova tentativa
// roda um `pip install` inteiro, então o intervalo cresce até 30 min em vez de
// martelar a cada 30 s num app de bandeja que sobe com o Windows.
const PROVISION_BACKOFF_MAX_MS = 30 * 60_000;

export interface WakewordSidecarOptions {
  /**
   * Python explícito, sem provisionamento. Omitido: em dev,
   * wakeword-sidecar/.venv/Scripts/python.exe; empacotado, o venv do userData
   * (criado na primeira execução e reinstalado quando o requirements.txt muda).
   */
  pythonPath?: string;
  /**
   * --model — omitido usa hey_luna_ptbr_v2.tflite: em dev, o default do
   * próprio wake_sidecar.py (relativo ao monorepo); empacotado, DEFAULT_MODEL_PATH
   * (resources/wakeword-sidecar/models/, ver comentário acima).
   */
  model?: string;
  /** --threshold — omitido usa o default do próprio wake_sidecar.py (0.85) */
  threshold?: number;
  /** --score-interval-ms — eventos `score` para o teste de mic do painel. Omitido desliga. */
  scoreIntervalMs?: number;
}

export interface WakewordSidecarEvents {
  ready: (info: Extract<WakewordEvent, { event: 'ready' }>) => void;
  wake: (info: Extract<WakewordEvent, { event: 'wake' }>) => void;
  score: (info: Extract<WakewordEvent, { event: 'score' }>) => void;
  crashed: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  restartScheduled: (delayMs: number) => void;
  fatalError: (message: string) => void;
  /** Preparando o venv: uma vez por preparação, com a primeira etapa (só empacotado). */
  provisioning: (stage: ProvisionStage) => void;
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
  /** Python pronto para o spawn; zera se o spawn falhar (venv apagado no meio). */
  private resolvedPython: string | null = null;
  private provisioningInFlight: Promise<void> | null = null;
  private provisionAbort: AbortController | null = null;
  /** Falhas seguidas de preparação: dita o backoff e cala a notificação repetida. */
  private provisionFailures = 0;
  private lastProvisionError: string | null = null;
  /** O processo atual mandou `ready`? Sair antes disso com venv provisionado = venv suspeito. */
  private sawReady = false;
  /** Uma repreparação forçada por execução do app, para não virar laço. */
  private forcedReprovision = false;

  constructor(private readonly opts: WakewordSidecarOptions = {}) {
    super();
  }

  /** Inicia o processo (e o ciclo de restart automático até stop()). */
  start(): void {
    this.stopped = false;
    this.launch();
  }

  /** Garante o Python (empacotado: venv no userData) e sobe o processo. */
  private launch(): void {
    const explicit = this.opts.pythonPath ?? (app.isPackaged ? null : DEV_PYTHON_PATH);
    if (explicit) {
      this.spawnChild(explicit);
      return;
    }
    if (this.resolvedPython) {
      this.spawnChild(this.resolvedPython);
      return;
    }
    // Um `setThreshold` no meio da instalação faz stop()+start(): a mesma
    // instalação serve, e o `.then` abaixo sobe o processo se ainda fizer sentido.
    if (this.provisioningInFlight) return;

    // Só a primeira etapa da primeira tentativa avisa: criar o venv já implica
    // instalar em seguida, e uma retentativa depois de falha já foi notificada.
    let announced = this.provisionFailures > 0;
    const abort = new AbortController();
    this.provisionAbort = abort;
    this.provisioningInFlight = ensureSidecarPython({
      venvDir: this.venvDir(),
      requirementsPath: join(SIDECAR_DIR, 'requirements.txt'),
      signal: abort.signal,
      onProvision: (stage) => {
        console.log(`[wakeword-sidecar] preparando o ambiente Python (${stage})`);
        if (!announced) this.emit('provisioning', stage);
        announced = true;
      },
    })
      .then((python) => {
        this.resolvedPython = python;
        this.provisionFailures = 0;
        this.lastProvisionError = null;
        if (!this.stopped && !this.child) this.spawnChild(python);
      })
      .catch((err: unknown) => {
        if (this.stopped) return; // app saindo ou reinício: o cancelamento é esperado
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[wakeword-sidecar] ${message}`);
        this.provisionFailures += 1;
        // Mesma falha de novo (ainda sem Python, ainda sem rede): só o log.
        if (message !== this.lastProvisionError) this.emit('fatalError', message);
        this.lastProvisionError = message;
        this.scheduleRestart(
          Math.min(FATAL_ERROR_BACKOFF_MS * 2 ** (this.provisionFailures - 1), PROVISION_BACKOFF_MAX_MS),
        );
      })
      .finally(() => {
        if (this.provisionAbort === abort) this.provisionAbort = null;
        this.provisioningInFlight = null;
      });
  }

  /** Encerra de vez — usado no app.quit(). Não reinicia depois disso. */
  stop(): void {
    this.stopped = true;
    // Mata o venv/pip em curso: órfão, ele continuaria escrevendo no venv
    // enquanto o app reaberto começa outro pip no mesmo lugar.
    this.provisionAbort?.abort();
    this.provisionAbort = null;
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

  /**
   * Limiar novo pelo painel (v2): o sidecar só lê `--threshold` no spawn, então
   * reinicia o processo. Alguns centésimos de segundo sem wake word — o `ready`
   * seguinte traz o limiar em vigor.
   */
  setThreshold(threshold: number | undefined): void {
    if (this.opts.threshold === threshold) return;
    this.opts.threshold = threshold;
    if (this.stopped) return;
    this.stop();
    this.start();
  }

  /** Escreve PCM16LE cru no stdin do sidecar. No-op se o processo não estiver de pé. */
  feed(pcm: Buffer): void {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(pcm);
  }

  private venvDir(): string {
    return join(app.getPath('userData'), 'wakeword-venv');
  }

  private spawnChild(pythonPath: string): void {
    const model = this.opts.model ?? DEFAULT_MODEL_PATH;
    const args = ['wake_sidecar.py', '--stdin'];
    if (model) args.push('--model', model);
    if (this.opts.threshold !== undefined) args.push('--threshold', String(this.opts.threshold));
    if (this.opts.scoreIntervalMs) args.push('--score-interval-ms', String(this.opts.scoreIntervalMs));

    // windowsHide: sem isso, cada (re)início do sidecar pisca uma janela de
    // console preta — python.exe é um console app, e o app de bandeja não tem
    // console próprio para herdar.
    const child = spawn(pythonPath, args, { cwd: SIDECAR_DIR, windowsHide: true });
    this.child = child;
    this.sawFatalError = false;
    this.sawReady = false;

    child.stdout.setEncoding('utf8');
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));

    // O sidecar já faz sys.stderr.reconfigure(encoding="utf-8") do lado
    // Python — o console do Windows tende a cp1252/cp850, então o lado Node
    // precisa decodificar como UTF-8 explicitamente também, senão acentos em
    // pt-BR (ex. "inferências", "detecção") saem como lixo no log.
    // Reiniciar pelo painel (`setThreshold`) mata o processo com o microfone
    // ainda escrevendo: EPIPE sem listener viraria uncaughtException no main.
    child.stdin.on('error', (err) => {
      if (this.child === child) console.warn(`[wakeword-sidecar] stdin: ${err.message}`);
    });

    child.stderr.setEncoding('utf8');
    createInterface({ input: child.stderr }).on('line', (line) => {
      console.warn(`[wakeword-sidecar] ${line}`);
    });

    child.on('error', (err) => {
      // Processo já substituído (reinício pelo painel): não é deste filho.
      if (this.child !== child) return;
      // Falha do próprio spawn (ex. python.exe não existe porque o venv não
      // foi criado) — não passa por 'exit', precisa de handler próprio.
      console.error(`[wakeword-sidecar] falha ao iniciar processo: ${err.message}`);
      // Venv sumiu depois de pronto: a próxima tentativa refaz o provisionamento.
      this.resolvedPython = null;
      this.emit('fatalError', err.message);
      this.child = null;
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // já substituído por um restart — eco do processo antigo
      this.child = null;
      if (this.stopped) return;
      console.warn(`[wakeword-sidecar] processo saiu (code=${code} signal=${signal})`);
      // Saiu antes do `ready` sem erro estruturado do próprio sidecar: o python
      // do venv existe mas não sobe (Python base desinstalado, site-packages
      // danificado). O hash do requirements não vê isso — força refazer o venv.
      if (
        this.resolvedPython !== null &&
        !this.sawReady &&
        !this.sawFatalError &&
        !this.forcedReprovision
      ) {
        console.warn('[wakeword-sidecar] venv não subiu — será recriado na próxima tentativa');
        this.forcedReprovision = true;
        invalidateSidecarVenv(this.venvDir());
        this.resolvedPython = null;
      }
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
        this.sawReady = true;
        this.backoffMs = RESTART_BACKOFF_INITIAL_MS; // processo saudável reseta o backoff
        this.emit('ready', event);
        break;
      case 'wake':
        this.emit('wake', event);
        break;
      case 'score':
        this.emit('score', event);
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

  private scheduleRestart(delayOverride?: number): void {
    if (this.stopped) return;

    const delay = delayOverride ?? (this.sawFatalError ? FATAL_ERROR_BACKOFF_MS : this.backoffMs);
    if (delayOverride === undefined) this.backoffMs = Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);

    this.emit('restartScheduled', delay);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.launch();
    }, delay);
  }
}
