// Máquina de estados do satélite virtual — módulo puro (sem `electron`, sem
// `ws`), testável com `node --test` e `mock.timers`, no mesmo espírito de
// state.ts. index.ts é quem liga os eventos daqui ao LunaWsClient (fecha/abre
// o uplink) e à janela oculta (IPC de captura/playback).

import type { AppState } from './state.js';

const THINKING_TIMEOUT_MS = 15_000;
const SPEAKING_TIMEOUT_MS = 5_000;

type TurnPhase = 'idle' | 'thinking' | 'speaking';

export interface TtfabInfo {
  /**
   * speaking_start → primeiro audio_response, em ms. Com o uplink fechado
   * exatamente no speaking_start, isto equivale ao "último áudio enviado →
   * primeira resposta" do luna-client-test — a mesma métrica, calculada de
   * um jeito que faz sentido sob streaming contínuo.
   */
  sinceSpeakingStartMs: number;
}

type Listener<Args extends unknown[]> = (...args: Args) => void;

/**
 * EventEmitter minimalista e tipado — evita puxar `node:events` (cujo
 * `.emit` genérico não checa os tipos de argumento) só para 4 eventos.
 */
class TypedEmitter<Events extends Record<string, unknown[]>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    (this.listeners[event] ??= new Set()).add(listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }
}

interface SessionEvents {
  stateChanged: [AppState];
  uplinkChanged: [boolean];
  ttfab: [TtfabInfo];
  flushPlayback: [];
  // Índice explícito: sem ele, TS recusa este tipo como argumento de
  // TypedEmitter<Events extends Record<string, unknown[]>> mesmo sendo
  // estruturalmente compatível — limitação conhecida de generics + interface.
  [event: string]: unknown[];
}

export class Session extends TypedEmitter<SessionEvents> {
  private connected = false;
  private muted = false;
  private turnPhase: TurnPhase = 'idle';
  /** Enquanto true, frames de audio_response são descartados: forceListen()
   * interrompeu um turno cujos frames de resposta ainda estavam a caminho. */
  private dropAudio = false;
  private thinkingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private speakingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private speakingStartedAt: number | null = null;
  /** true = mic local ativo, alimentando o sidecar de wake word, mas o
   * uplink pro servidor está fechado até um "Hey Luna" (ou bypass manual). */
  private awaitingWake = true;
  /** false enquanto o processo do sidecar de wake word está fora do ar —
   * força 'error' em repouso (ver recompute()), mesmo tratamento de !connected. */
  private sidecarHealthy = true;

  private state: AppState = 'error';
  private uplinkOpen = false;

  getState(): AppState {
    return this.state;
  }

  isUplinkOpen(): boolean {
    return this.uplinkOpen;
  }

  isMuted(): boolean {
    return this.muted;
  }

  // --- ciclo de vida da conexão (chamado pelos eventos do LunaWsClient) ---

  onConnecting(): void {
    this.connected = false;
    this.resetTurn();
    this.recompute();
  }

  onAuthOk(): void {
    this.connected = true;
    this.recompute();
  }

  onDisconnected(): void {
    this.connected = false;
    this.resetTurn();
    this.recompute();
  }

  // --- controle vindo do servidor ---

  onSpeakingStart(): void {
    // O servidor só manda um speaking_start por turno (speakingByRoom no
    // Orchestrator) — um segundo enquanto já em thinking/speaking é
    // duplicata/glitch de rede, não um novo turno. Ignora em vez de reiniciar
    // o relógio de TTFAB no meio de uma resposta.
    if (this.turnPhase !== 'idle') return;
    this.clearWatchdogs();
    this.dropAudio = false;
    this.turnPhase = 'thinking';
    this.speakingStartedAt = Date.now();
    this.thinkingWatchdog = setTimeout(() => this.watchdogFired('thinking'), THINKING_TIMEOUT_MS);
    this.recompute();
  }

  onSpeakingEnd(): void {
    this.resetTurn();
    this.recompute();
  }

  /**
   * Chamado a cada frame de audio_response recebido. Retorna true quando o
   * PCM deve ser tocado — index.ts só repassa ao renderer nesse caso. Retorna
   * false enquanto dropAudio está ativo (barge-in em andamento: frames que o
   * servidor já tinha mandado antes de perceber a interrupção).
   */
  onAudioResponseFrame(): boolean {
    if (this.dropAudio) return false;

    if (this.turnPhase !== 'speaking') {
      // 1º chunk do turno — inclui o caso (fora de ordem, mas o protocolo não
      // garante) de áudio chegando sem um speaking_start prévio.
      this.clearWatchdogs();
      this.turnPhase = 'speaking';
      if (this.speakingStartedAt !== null) {
        this.emit('ttfab', { sinceSpeakingStartMs: Date.now() - this.speakingStartedAt });
      }
      this.recompute();
    }

    this.armSpeakingWatchdog();
    return true;
  }

  // --- controles locais (menu / tray / sidecar de wake word) ---

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    // Mudo muta tudo, incluindo a detecção de wake — desmutar não deve
    // reabrir um streaming pendurado sozinho, precisa de um novo "Hey Luna".
    if (muted) this.awaitingWake = true;
    this.recompute();
  }

  /**
   * Evento `wake` do sidecar de wake word (index.ts liga isto ao evento
   * `wake` de WakewordSidecar). Mesmo efeito de forceListen(): abre o gate a
   * partir do repouso, ou interrompe um turno em andamento (barge-in).
   */
  onWakeDetected(): void {
    this.openGate();
  }

  /**
   * Reflete se o processo do sidecar de wake word está de pé
   * (WakewordSidecar 'ready'/'crashed' em index.ts). Só afeta o estado
   * público em repouso — não interrompe um turno já em thinking/speaking se
   * o sidecar cair no meio de uma resposta, mesmo princípio que muted já
   * respeita hoje.
   */
  setSidecarHealthy(healthy: boolean): void {
    if (this.sidecarHealthy === healthy) return;
    this.sidecarHealthy = healthy;
    this.recompute();
  }

  /**
   * "Forçar escuta agora": bypass manual do wake word, disparado pelo item de
   * menu. Mesmo efeito de onWakeDetected() — abre o gate mesmo em repouso, e
   * interrompe um turno em andamento se houver.
   */
  forceListen(): void {
    this.openGate();
  }

  destroy(): void {
    this.clearWatchdogs();
  }

  // --- internals ---

  /**
   * Compartilhado por forceListen() (bypass manual) e onWakeDetected()
   * (gatilho do sidecar): interrompe um turno em andamento se houver, e
   * sempre abre o gate de wake. recompute() só emite se algo mudou de fato,
   * então chamar isto sem turno ativo e já fora de awaitingWake é inofensivo.
   *
   * No-op enquanto mudo: sem essa guarda, forceListen() zeraria awaitingWake
   * silenciosamente (o estado visível continua 'idle' porque muted também
   * força isso em recompute()) e o próximo setMuted(false) reabriria o
   * uplink sem exigir um novo "Hey Luna" — quebraria a garantia de que
   * desmutar nunca reabre sozinho.
   */
  private openGate(): void {
    if (this.muted) return;

    if (this.turnPhase !== 'idle') {
      this.clearWatchdogs();
      this.dropAudio = true;
      this.turnPhase = 'idle';
      this.speakingStartedAt = null;
      this.emit('flushPlayback');
    }
    this.awaitingWake = false;
    this.recompute();
  }

  private resetTurn(): void {
    this.clearWatchdogs();
    this.turnPhase = 'idle';
    this.dropAudio = false;
    this.speakingStartedAt = null;
    // Fim de turno volta a exigir um novo "Hey Luna" — chamado por
    // onConnecting/onDisconnected/onSpeakingEnd/watchdogFired, então isto
    // cobre todos os jeitos de um turno terminar sem precisar tocar neles.
    this.awaitingWake = true;
  }

  private armSpeakingWatchdog(): void {
    if (this.speakingWatchdog) clearTimeout(this.speakingWatchdog);
    this.speakingWatchdog = setTimeout(() => this.watchdogFired('speaking'), SPEAKING_TIMEOUT_MS);
  }

  /**
   * Um speaking_end que nunca chega (turno abandonado pelo provider) deixaria
   * o app preso em thinking/speaking para sempre — surdo, porque o uplink
   * continuaria fechado. Mesma classe do bug de corte de VAD já visto neste
   * projeto (ver luna-vad-cutoff-freeze-bug). Os watchdogs são a rede de
   * segurança: sem progresso dentro do prazo, volta a ouvir sozinho.
   */
  private watchdogFired(phase: TurnPhase): void {
    console.warn(`[luna-desktop] watchdog: sem progresso em '${phase}' — voltando a ouvir`);
    this.resetTurn();
    this.emit('flushPlayback');
    this.recompute();
  }

  private clearWatchdogs(): void {
    if (this.thinkingWatchdog) {
      clearTimeout(this.thinkingWatchdog);
      this.thinkingWatchdog = null;
    }
    if (this.speakingWatchdog) {
      clearTimeout(this.speakingWatchdog);
      this.speakingWatchdog = null;
    }
  }

  private recompute(): void {
    const nextState: AppState = !this.connected
      ? 'error'
      : this.turnPhase === 'thinking'
        ? 'thinking'
        : this.turnPhase === 'speaking'
          ? 'speaking'
          : !this.sidecarHealthy
            ? 'error'
            : this.muted || this.awaitingWake
              ? 'idle'
              : 'listening';

    const nextUplink =
      this.connected && this.turnPhase === 'idle' && !this.muted && !this.awaitingWake;

    if (nextState !== this.state) {
      this.state = nextState;
      this.emit('stateChanged', nextState);
    }
    if (nextUplink !== this.uplinkOpen) {
      this.uplinkOpen = nextUplink;
      this.emit('uplinkChanged', nextUplink);
    }
  }
}
