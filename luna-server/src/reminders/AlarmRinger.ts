import type { Reminder, ReminderStore } from './ReminderStore.js';
import type { ReminderScheduler } from './ReminderScheduler.js';
import type { NowFn } from '../time/clock.js';
import { systemNow } from '../time/clock.js';
import { CHIME_DURATION_MS } from './chime.js';
import { getLogger } from '../logging/logger.js';

/**
 * O ciclo de toque de um alarme: rajada → janela de escuta → rajada, até
 * alguém dispensar, adiar, ou o teto de `maxRingMs` estourar.
 *
 * A janela existe por uma razão só: em `RESPONDING` o firmware **desliga a
 * wake word**. Um alarme que toca continuamente é um alarme que não se desliga
 * por voz. Entre uma rajada e outra o satélite volta a `IDLE_LISTENING` e
 * "Luna, para o alarme" tem onde ser ouvido.
 *
 * Este módulo não conhece o `Orchestrator`: recebe uma porta estreita
 * (`AlarmAudioSink`). O caminho contrário criaria import circular, já que o
 * Orchestrator é quem constrói o ringer.
 */

/** Resultado de uma rajada. Ver `AlarmAudioSink.ringBurst`. */
export type BurstResult = 'delivered' | 'busy' | 'silent';

export interface AlarmAudioSink {
  /**
   * Toca uma rajada no cômodo.
   *
   * `busy` e `silent` são zero entregas pelos dois motivos **opostos**: "tem
   * alguém falando aqui, espera a próxima janela" contra "não tem ninguém para
   * ouvir". Confundir os dois faria o alarme desistir justamente quando a
   * pessoa está tentando dispensá-lo.
   *
   * `force` ignora **só** a guarda de fala do usuário (ver `RING_MAX_DEFER_MS`).
   * Um turno da própria Luna em voo continua bloqueando de qualquer jeito:
   * empurrar o chime por cima intercalaria frames no meio da resposta dela.
   */
  ringBurst(roomId: string, force?: boolean): BurstResult;
}

/** Por que o ciclo terminou. */
export type RingOutcome =
  | 'dismissed'
  | 'snoozed'
  | 'exhausted'
  | 'room_gone'
  | 'shutdown';

/** De onde veio a dispensa — só para log, mas é o que diagnostica o hardware. */
export type DismissReason = 'tool' | 'turn_complete';

/**
 * Teto de adiamento por barge-in.
 *
 * Sem ele, um cômodo que transmite sem parar nunca ouviria o alarme: é
 * exatamente o caso do `luna-client-test --mic` e do `luna-desktop`, que não
 * têm wake word e mandam áudio continuamente. Um alarme que **nunca toca** é
 * pior que um que trunca uma frase, então passado este teto a rajada sai assim
 * mesmo, com log alto.
 *
 * 2026-08-24: não medido no hardware — não havia satélite disponível nesta
 * rodada. Calibrar junto com `ringListenWindowMs`.
 */
export const RING_MAX_DEFER_MS = 3_000;

/** Espera entre duas tentativas quando a rajada está adiada pelo barge-in. */
const RING_DEFER_RETRY_MS = 1_000;

export interface AlarmRingerOptions {
  store: ReminderStore;
  sink: AlarmAudioSink;
  /** Janela de escuta entre rajadas — a única em que a wake word está ligada. */
  listenWindowMs: number;
  /** Teto do ciclo inteiro. */
  maxRingMs: number;
  /** Espera antes de tentar de novo quando o cômodo emudeceu no meio do toque. */
  silentRetryMs: number;
  /** Carência do catch-up; limita por quanto tempo faz sentido reinsistir. */
  missedGraceMs: number;
  /** Teto da soneca pedida por voz, em minutos. */
  snoozeMaxMinutes: number;
  /** Cômodo de fallback quando a origem está muda. Vazio desliga o fallback. */
  fallbackRoomId: string;
  /** Injetável para teste, mesmo padrão do resto do módulo de lembretes. */
  now?: NowFn;
}

interface RingCycle {
  reminderId: number;
  shortId: string;
  label: string | null;
  /** Cômodo em que EFETIVAMENTE toca — pode ser o fallback, não o de origem. */
  roomId: string;
  originRoomId: string;
  startedAt: number;
  burstCount: number;
  /** Já entregou pelo menos uma rajada? Separa "sala vazia" de "sala esvaziou". */
  deliveredOnce: boolean;
  deferredMs: number;
  /** Fim da última rajada: é o offset que calibra a janela no hardware. */
  lastBurstAt: number;
  timer: NodeJS.Timeout | null;
  done: boolean;
  snoozeUntil: number | null;
  resolve: () => void;
}

export class AlarmRinger {
  private readonly store: ReminderStore;
  private readonly sink: AlarmAudioSink;
  private readonly listenWindowMs: number;
  private readonly maxRingMs: number;
  private readonly silentRetryMs: number;
  private readonly missedGraceMs: number;
  private readonly snoozeMaxMinutes: number;
  private readonly fallbackRoomId: string;
  private readonly now: NowFn;

  /**
   * Ciclos em voo, chaveados pelo cômodo **em que tocam**. Uma dispensa por voz
   * chega do cômodo onde a pessoa está, e é lá que o alarme está tocando.
   *
   * Este estado tem ciclo de vida próprio, de propósito: `releaseRoom` limpa os
   * mapas por sala do Orchestrator quando o provider morre, mas uma sala cujo
   * provider morreu **continua tendo alarmes**. Apagar o ciclo junto mataria o
   * toque no meio.
   */
  private readonly activeByRoom = new Map<string, RingCycle>();

  /**
   * Late-bound: o scheduler nasce depois do ringer (o `onFire` dele é o
   * `ring()` daqui), mas todo fim de ciclo precisa de um `reschedule()` —
   * senão uma soneca de 1 minuto esperaria a acordada seguinte, que o clamp de
   * `MAX_TIMER_DELAY_MS` põe a até 60 s de distância.
   */
  private scheduler: ReminderScheduler | null = null;

  private stopped = false;

  constructor(options: AlarmRingerOptions) {
    this.store = options.store;
    this.sink = options.sink;
    this.listenWindowMs = options.listenWindowMs;
    this.maxRingMs = options.maxRingMs;
    this.silentRetryMs = options.silentRetryMs;
    this.missedGraceMs = options.missedGraceMs;
    this.snoozeMaxMinutes = options.snoozeMaxMinutes;
    this.fallbackRoomId = options.fallbackRoomId;
    this.now = options.now ?? systemNow;
  }

  setScheduler(scheduler: ReminderScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * Sink do `ReminderScheduler`. A promise resolve só no **fim do ciclo**, não
   * na primeira rajada: é ela que segura a vaga em `firingRooms` enquanto o
   * alarme toca.
   *
   * Sem isso `firingRooms` libera em microssegundos e um segundo lembrete da
   * mesma sala poderia ser disparado por cima — com `markRinging` já gravado,
   * `next_due_utc` avançado e `fire_count++` num lembrete que nunca tocou.
   * Corrupção de dado, não só de UX.
   */
  ring(reminder: Reminder): Promise<void> {
    if (this.stopped) return Promise.resolve();

    const roomId = reminder.roomId;
    if (this.activeByRoom.has(roomId)) {
      // O scheduler já impede dois disparos na mesma sala (`firingRooms`);
      // chegar aqui é bug de wiring, não entrada de usuário.
      getLogger().error(
        { event: 'alarm_room_busy', room_id: roomId, reminder_id: reminder.id },
        `Já há alarme tocando em ${roomId}: ${reminder.shortId} não vai tocar agora`,
      );
      this.store.rearm(reminder.id, this.now().getTime() + this.silentRetryMs);
      this.scheduler?.reschedule();
      return Promise.resolve();
    }

    const startedAt = this.now().getTime();
    return new Promise<void>((resolve) => {
      const cycle: RingCycle = {
        reminderId: reminder.id,
        shortId: reminder.shortId,
        label: reminder.label,
        roomId,
        originRoomId: roomId,
        startedAt,
        burstCount: 0,
        deliveredOnce: false,
        deferredMs: 0,
        lastBurstAt: startedAt,
        timer: null,
        done: false,
        snoozeUntil: null,
        resolve,
      };
      this.activeByRoom.set(roomId, cycle);
      this.step(cycle);
    });
  }

  /** "Luna, para o alarme", ou o fim de qualquer turno na sala que toca. */
  dismiss(roomId: string, reason: DismissReason): boolean {
    const cycle = this.activeByRoom.get(roomId);
    if (!cycle) return false;

    getLogger().info(
      {
        event: 'alarm_dismissed',
        room_id: roomId,
        reminder_id: cycle.reminderId,
        short_id: cycle.shortId,
        reason,
        bursts: cycle.burstCount,
        // Onde, dentro da janela de escuta, a dispensa chegou. É o número que
        // calibra `ringListenWindowMs` quando houver hardware: se vier sempre
        // perto do teto, a janela está curta.
        listen_offset_ms: this.now().getTime() - cycle.lastBurstAt,
      },
      `Alarme ${cycle.shortId} dispensado em ${roomId}`,
    );
    this.finish(cycle, 'dismissed');
    return true;
  }

  /** "soneca de cinco minutos". No-op quando nada toca. */
  snooze(
    roomId: string,
    minutes: number,
  ): { ok: false } | { ok: true; minutes: number; nextDueUtc: number } {
    const cycle = this.activeByRoom.get(roomId);
    if (!cycle) return { ok: false };

    const clamped = Math.min(Math.max(Math.round(minutes), 1), this.snoozeMaxMinutes);
    const nextDueUtc = this.now().getTime() + clamped * 60_000;
    cycle.snoozeUntil = nextDueUtc;

    getLogger().info(
      {
        event: 'alarm_snoozed',
        room_id: roomId,
        reminder_id: cycle.reminderId,
        short_id: cycle.shortId,
        minutes: clamped,
        next_due_utc: nextDueUtc,
      },
      `Alarme ${cycle.shortId} adiado ${clamped} min`,
    );
    this.finish(cycle, 'snoozed');
    return { ok: true, minutes: clamped, nextDueUtc };
  }

  /** O que está tocando nesta sala, para o handler montar a fala. */
  ringingIn(roomId: string): { shortId: string; label: string | null } | null {
    const cycle = this.activeByRoom.get(roomId);
    return cycle ? { shortId: cycle.shortId, label: cycle.label } : null;
  }

  isRinging(roomId: string): boolean {
    return this.activeByRoom.has(roomId);
  }

  /**
   * Shutdown. Fecha todo ciclo em voo **antes** de o store fechar — daí a ordem
   * em `index.ts`: scheduler, ringer, e só então `store.close()`.
   */
  stop(): void {
    this.stopped = true;
    for (const cycle of [...this.activeByRoom.values()]) {
      this.finish(cycle, 'shutdown');
    }
  }

  /** Uma volta da FSM: decide entre tocar, adiar, ou encerrar. */
  private step(cycle: RingCycle): void {
    if (cycle.done || this.stopped) return;

    const now = this.now().getTime();
    if (now - cycle.startedAt >= this.maxRingMs) {
      getLogger().info(
        {
          event: 'alarm_exhausted',
          room_id: cycle.roomId,
          reminder_id: cycle.reminderId,
          short_id: cycle.shortId,
          bursts: cycle.burstCount,
          max_ring_ms: this.maxRingMs,
        },
        `Alarme ${cycle.shortId} tocou até o teto sem ninguém dispensar`,
      );
      this.finish(cycle, 'exhausted');
      return;
    }

    // Passado o teto de adiamento, a rajada sai por cima da fala do usuário: um
    // cômodo que nunca silencia (o `--mic` do cliente de teste, o desktop) não
    // pode significar um alarme que nunca toca.
    const force = cycle.deferredMs >= RING_MAX_DEFER_MS;
    const result = this.sink.ringBurst(cycle.roomId, force);

    if (result === 'busy') {
      // Uma rajada agora cortaria a frase pelo `xQueueReset(txQueue)` do
      // firmware — ou, com `force`, é a própria Luna que está falando, e aí
      // não se atropela mesmo. O teto de `maxRingMs` é quem encerra se isto
      // nunca destravar.
      cycle.deferredMs += RING_DEFER_RETRY_MS;
      this.schedule(cycle, RING_DEFER_RETRY_MS);
      return;
    }

    if (force) {
      getLogger().warn(
        {
          event: 'alarm_burst_forced',
          room_id: cycle.roomId,
          reminder_id: cycle.reminderId,
          deferred_ms: cycle.deferredMs,
        },
        `Cômodo ${cycle.roomId} nunca silencia: tocando por cima`,
      );
    }

    if (result === 'silent') {
      const pulou = this.tryFallbackRoom(cycle);
      if (!pulou) {
        this.finish(cycle, 'room_gone');
        return;
      }
    } else {
      cycle.deliveredOnce = true;
    }

    cycle.burstCount += 1;
    cycle.deferredMs = 0;
    cycle.lastBurstAt = this.now().getTime();

    // Próxima rajada depois do bipe inteiro mais a janela de escuta. A fila de
    // áudio é paceada em `AUDIO_FRAME_INTERVAL_MS` por frame, então drenar o
    // chime leva a própria duração dele — nada de esperar confirmação, que o
    // protocolo não tem (nenhum MessageType novo na v1).
    this.schedule(cycle, CHIME_DURATION_MS + this.listenWindowMs);
  }

  /**
   * Origem muda na **primeira** rajada: repete a rajada no cômodo de fallback e
   * o ciclo inteiro passa a viver lá — inclusive a dispensa.
   *
   * A partir da segunda rajada não há pulo: o cômodo escureceu no meio do
   * toque, e um alarme que persegue gente pela casa é explicitamente fora de
   * escopo. Fallback é config fixa, burra de propósito.
   */
  private tryFallbackRoom(cycle: RingCycle): boolean {
    if (cycle.deliveredOnce) return false;
    if (!this.fallbackRoomId || this.fallbackRoomId === cycle.roomId) return false;

    const result = this.sink.ringBurst(this.fallbackRoomId);
    if (result !== 'delivered') return false;

    this.activeByRoom.delete(cycle.roomId);
    cycle.roomId = this.fallbackRoomId;
    this.activeByRoom.set(cycle.roomId, cycle);
    cycle.deliveredOnce = true;

    getLogger().info(
      {
        event: 'alarm_fallback_room',
        room_id: cycle.originRoomId,
        fallback_room_id: cycle.roomId,
        reminder_id: cycle.reminderId,
        short_id: cycle.shortId,
      },
      `${cycle.originRoomId} está mudo: alarme ${cycle.shortId} tocando em ${cycle.roomId}`,
    );
    return true;
  }

  private schedule(cycle: RingCycle, delayMs: number): void {
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.timer = setTimeout(() => {
      cycle.timer = null;
      this.step(cycle);
    }, delayMs);
    // Mesmo padrão de `ReminderScheduler` e `deviceRegistrySource`: sem isto um
    // timer pendurado segura o event loop e `node --test` nunca termina.
    cycle.timer.unref();
  }

  /**
   * Saída única do ciclo, e o ponto que fecha o `ringing` no banco.
   *
   * Antes deste módulo existir, **ninguém** tirava o lembrete de `ringing` em
   * runtime: só o `recoverStaleRinging` do boot seguinte. Um one-shot ficava
   * preso para sempre e um recorrente nunca mais disparava até reiniciar.
   */
  private finish(cycle: RingCycle, outcome: RingOutcome): void {
    if (cycle.done) return; // dispensa correndo com o teto: resolve UMA vez
    cycle.done = true;
    if (cycle.timer) {
      clearTimeout(cycle.timer);
      cycle.timer = null;
    }
    this.activeByRoom.delete(cycle.roomId);

    const now = this.now().getTime();
    try {
      const atual = this.store.get(cycle.reminderId);
      // Um `cancel` que chegou pela tool durante o toque já gravou estado
      // terminal. O fim do ciclo não pode desfazer isso.
      if (atual && atual.status === 'ringing') {
        this.closeInStore(cycle, atual, outcome, now);
      }
    } catch (err: unknown) {
      // Uma falha do SQLite não pode deixar a vaga de `firingRooms` presa: a
      // sala ficaria bloqueada até o restart.
      getLogger().error(
        {
          event: 'alarm_close_failed',
          room_id: cycle.roomId,
          reminder_id: cycle.reminderId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Falha ao fechar o lembrete no fim do toque',
      );
    } finally {
      this.scheduler?.reschedule();
      cycle.resolve();
    }
  }

  private closeInStore(
    cycle: RingCycle,
    atual: Reminder,
    outcome: RingOutcome,
    now: number,
  ): void {
    if (outcome === 'snoozed' && cycle.snoozeUntil !== null) {
      // Soneca é `UPDATE next_due_utc`, sem tabela à parte — o `list` depende
      // do invariante "uma linha = um lembrete visível ao usuário". Num
      // recorrente a regra continua intacta em `repeat_rule`, e a ocorrência
      // seguinte é recomputada a partir do instante adiado.
      this.store.rearm(cycle.reminderId, cycle.snoozeUntil, now);
      return;
    }

    if (atual.kind === 'recurring') {
      // `markRinging` JÁ avançou `next_due_utc` para a próxima ocorrência.
      // Rearmar é só devolver o status, com o MESMO instante — recalcular aqui
      // duplicaria a aritmética de recorrência e daria drift.
      this.store.rearm(cycle.reminderId, atual.nextDueUtc, now);
      return;
    }

    if (outcome === 'room_gone' || outcome === 'shutdown') {
      this.retryOrGiveUp(cycle, atual, now);
      return;
    }

    this.store.markStatus(cycle.reminderId, 'done', now);
  }

  /**
   * Cômodo mudo num one-shot. A decisão 16 do plano diz "o ciclo para e o
   * registro volta a `armed`" — mas rearmar com o vencimento **original** é um
   * laço quente: `next_due_utc` no passado faz `reschedule()` calcular
   * `delay = 0`, o `tick()` dispara de novo na hora, a sala continua muda, e
   * isso se repete milhares de vezes até a carência expirar, inflando
   * `fire_count` junto.
   *
   * O retry é sempre para o futuro, e a carência é medida contra o vencimento
   * **original** (`due_at_utc`, que `markRinging` não toca) — senão cada
   * tentativa zeraria o atraso e o lembrete insistiria para sempre.
   */
  private retryOrGiveUp(cycle: RingCycle, atual: Reminder, now: number): void {
    const original = atual.dueAtUtc ?? atual.nextDueUtc;
    const retryAt = now + this.silentRetryMs;

    if (retryAt - original <= this.missedGraceMs) {
      this.store.rearm(cycle.reminderId, retryAt, now);
      getLogger().warn(
        {
          event: 'alarm_room_offline',
          room_id: cycle.roomId,
          reminder_id: cycle.reminderId,
          short_id: cycle.shortId,
          retry_at: retryAt,
        },
        `Ninguém em ${cycle.roomId} para ouvir ${cycle.shortId}: nova tentativa em breve`,
      );
      return;
    }

    this.store.markStatus(cycle.reminderId, 'missed', now);
    getLogger().warn(
      {
        event: 'alarm_missed',
        room_id: cycle.roomId,
        reminder_id: cycle.reminderId,
        short_id: cycle.shortId,
      },
      `Lembrete ${cycle.shortId} venceu sem ninguém para ouvir`,
    );
  }
}
