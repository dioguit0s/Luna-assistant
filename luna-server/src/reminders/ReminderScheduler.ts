import type { Reminder, ReminderStore } from './ReminderStore.js';
import type { NowFn } from '../time/clock.js';
import { systemNow } from '../time/clock.js';
import { getLogger } from '../logging/logger.js';

/**
 * Teto de espera de cada acordada do timer.
 *
 * Um `setTimeout` por alarme, ou um único timer agendado direto para o
 * vencimento, quebra de três formas: o teto de ~24,8 dias do `setTimeout`, o
 * drift do relógio, e o salto de NTP ou a suspensão da VM — que o `setTimeout`
 * não acompanha, porque conta tempo monotônico, não hora de parede. Clampar em
 * 60 s e re-derivar `delay = due - now()` a cada acordada resolve os três de
 * uma vez. Não é polling burro: é um timer só, auto-corretivo.
 */
export const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Piso de reagendamento quando o próximo vencido não pode disparar agora —
 * nem por teto de concorrência, nem porque o cômodo dele já está tocando.
 *
 * Sem isto, `reschedule()` calcularia `delay = due - now()` para esse
 * lembrete vencido, que dá 0 (ou negativo, clampado em 0) — um timer de 0 ms
 * que, ao disparar, esbarra no mesmo bloqueio e reagenda outro de 0 ms, de
 * novo, sem o relógio nunca avançar nem o estado nunca mudar: busy loop de
 * verdade, trava o event loop. O caminho normal de reagendamento (a vaga
 * liberando, no `.finally()` de `fire()`) continua imediato; isto é só o piso
 * do fallback por timer.
 */
const THROTTLE_RETRY_MS = 1_000;

/** Sink de disparo. No marco 7 vira o `AlarmRinger`; aqui é injetado. */
export type FireReminder = (reminder: Reminder) => void | Promise<void>;

/**
 * Próxima ocorrência de um recorrente **depois** de `after`, ou `null` quando
 * não há como saber. Injetável: a aritmética de recorrência é do
 * `recurrence.ts`, e o scheduler só precisa do número.
 */
export type NextDueFn = (reminder: Reminder, after: number) => number | null;

/**
 * Sem função de recorrência, um recorrente não tem como ser rearmado — e
 * deixá-lo `armed` com vencimento no passado o faria ser reprocessado a cada
 * acordada, para sempre. Vira `missed`, com log alto.
 */
const REFUSE_RECURRING: NextDueFn = () => null;

export interface ReminderSchedulerOptions {
  store: ReminderStore;
  /** Chamado quando um lembrete vence dentro da carência. */
  onFire: FireReminder;
  /** Carência do catch-up: mais velho que isto no boot já não toca. */
  missedGraceMs: number;
  /** Teto do ciclo de toque; usado no boot para fechar `ringing` órfão. */
  maxRingMs: number;
  /** Teto de disparos simultâneos: 20 alarmes não podem abrir 20 sessões. */
  maxConcurrent: number;
  /** Injetável para testar com relógio falso, sem wall-clock. */
  now?: NowFn;
  nextDueAfter?: NextDueFn;
}

/**
 * Um timer só, auto-corretivo, para todos os lembretes de todos os cômodos.
 *
 * O satélite não participa: o firmware não configura NTP nem RTC — só
 * `millis()`/`esp_timer`, e os `ts` do envelope WS são uptime, não hora de
 * parede. Todo o agendamento é aqui.
 */
export class ReminderScheduler {
  private readonly store: ReminderStore;
  private readonly onFire: FireReminder;
  private readonly missedGraceMs: number;
  private readonly maxRingMs: number;
  private readonly maxConcurrent: number;
  private readonly now: NowFn;
  private readonly nextDueAfter: NextDueFn;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Cômodos com disparo em voo: o ciclo de toque é uma FSM por sala. */
  private readonly firingRooms = new Set<string>();

  constructor(options: ReminderSchedulerOptions) {
    this.store = options.store;
    this.onFire = options.onFire;
    this.missedGraceMs = options.missedGraceMs;
    this.maxRingMs = options.maxRingMs;
    this.maxConcurrent = options.maxConcurrent;
    this.now = options.now ?? systemNow;
    this.nextDueAfter = options.nextDueAfter ?? REFUSE_RECURRING;
  }

  /**
   * Rehydrate: fecha o que ficou preso em `ringing` de um processo anterior e
   * arma o timer a partir do banco. É o que faz um alarme sobreviver ao deploy
   * — o estado vive no SQLite, não em memória.
   */
  start(): void {
    this.stopped = false;
    this.store.recoverStaleRinging(this.maxRingMs, this.now().getTime());
    this.reschedule();
  }

  /**
   * Chamado no shutdown, ao lado de `deviceRegistry.stop()`, e por quem
   * cancelar um lembrete. Idempotente.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Rearma o timer a partir do estado atual do banco. Público porque criar,
   * cancelar ou adiar um lembrete muda quem é o próximo a vencer, e com o
   * clamp de 60 s um lembrete para daqui a 10 s esperaria a acordada seguinte.
   */
  reschedule(): void {
    if (this.stopped) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const next = this.store.nextArmed();
    if (!next) return;

    const now = this.now().getTime();
    const rawDelay = Math.max(next.nextDueUtc - now, 0);

    // Vencido agora mesmo, mas não pode disparar: teto de concorrência cheio,
    // ou o próprio cômodo dele já está tocando. Os dois são a mesma condição
    // de bloqueio do lado de dentro de `tick()` (o `break` e o `continue`);
    // aqui reconstruída sem depender de estado guardado de uma acordada
    // anterior, só do banco e de `firingRooms` agora.
    const blocked =
      rawDelay === 0 &&
      (this.firingRooms.size >= this.maxConcurrent || this.firingRooms.has(next.roomId));

    const delay = Math.min(blocked ? THROTTLE_RETRY_MS : rawDelay, MAX_TIMER_DELAY_MS);

    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    // Mesmo padrão de `deviceRegistrySource`: sem isto, um timer pendurado
    // segura o event loop e `node --test` nunca termina.
    this.timer.unref();
  }

  /** Exposto para teste: uma acordada do timer, sem esperar wall-clock. */
  tick(): void {
    if (this.stopped) return;

    const now = this.now().getTime();

    for (const reminder of this.store.listDue(now)) {
      const atraso = now - reminder.nextDueUtc;

      if (atraso > this.missedGraceMs) {
        this.markMissed(reminder, now);
        continue;
      }

      if (this.firingRooms.size >= this.maxConcurrent) {
        // Fica `armed`: pega a vez na próxima acordada. A carência de
        // `missedGraceMs` é ordens de grandeza maior que um ciclo de toque,
        // então esperar a vez não custa o alarme.
        break;
      }
      if (this.firingRooms.has(reminder.roomId)) continue;

      this.fire(reminder, now);
    }

    this.reschedule();
  }

  /**
   * Vencido demais para tocar. Um deploy às 3h depois de 3h fora não pode
   * disparar o alarme das 6:30 às 9:30, nem despejar um dia de alarmes de uma
   * vez.
   *
   * Recorrente não vira `missed`: ele avança para a próxima ocorrência futura
   * e continua armado — e avança **sem tocar**, colapsando um catch-up de
   * vários dias numa ocorrência só.
   */
  private markMissed(reminder: Reminder, now: number): void {
    if (reminder.kind === 'recurring') {
      const proxima = this.advanceRecurring(reminder, now);
      if (proxima !== null) {
        this.store.rearm(reminder.id, proxima, now);
        getLogger().info(
          {
            event: 'reminder_catchup_collapsed',
            reminder_id: reminder.id,
            room_id: reminder.roomId,
            next_due_utc: proxima,
          },
          'Recorrente vencido fora da carência: avançado sem tocar',
        );
        return;
      }
    }

    this.store.markStatus(reminder.id, 'missed', now);
    getLogger().warn(
      {
        event: 'reminder_missed',
        reminder_id: reminder.id,
        room_id: reminder.roomId,
        late_ms: now - reminder.nextDueUtc,
        grace_ms: this.missedGraceMs,
      },
      'Lembrete vencido além da carência: marcado como perdido',
    );
  }

  private fire(reminder: Reminder, now: number): void {
    // `ringing` e o avanço de `next_due_utc` são gravados na mesma transação,
    // ANTES de o disparo sair. Sem isso, um crash no meio do toque re-dispara
    // o one-shot a cada boot.
    const proxima =
      reminder.kind === 'recurring'
        ? this.advanceRecurring(reminder, now)
        : reminder.nextDueUtc;

    if (proxima === null) {
      this.store.markStatus(reminder.id, 'missed', now);
      return;
    }

    this.store.markRinging(reminder.id, proxima, now);

    const emToque = this.store.get(reminder.id);
    if (!emToque) return;

    this.firingRooms.add(reminder.roomId);
    getLogger().info(
      {
        event: 'reminder_fired',
        reminder_id: emToque.id,
        short_id: emToque.shortId,
        room_id: emToque.roomId,
        kind: emToque.kind,
        late_ms: now - reminder.nextDueUtc,
        fire_count: emToque.fireCount,
      },
      `Lembrete disparado em ${emToque.roomId}`,
    );

    // O sink pode ser síncrono ou assíncrono; `Promise.resolve` unifica os dois
    // e o `.catch` garante que uma falha do toque não deixe a sala travada.
    void Promise.resolve()
      .then(() => this.onFire(emToque))
      .catch((err: unknown) => {
        getLogger().error(
          {
            event: 'reminder_fire_failed',
            reminder_id: emToque.id,
            room_id: emToque.roomId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Falha ao tocar o lembrete',
        );
      })
      .finally(() => {
        this.firingRooms.delete(emToque.roomId);
        // A vaga liberou: quem estava barrado pelo teto de concorrência ou por
        // "esta sala já está tocando" tem que ser reavaliado agora, não na
        // próxima acordada. Com o ciclo de toque durando minutos (o `onFire`
        // do `AlarmRinger` só resolve no fim), sem isto o fallback de
        // THROTTLE_RETRY_MS ficaria repolling de segundo em segundo até lá.
        this.reschedule();
      });
  }

  /**
   * Próxima ocorrência estritamente futura, colapsando um atraso de vários
   * dias numa só. O teto de iterações existe porque `nextDueAfter` é injetado:
   * uma implementação que não avança viraria laço infinito aqui.
   */
  private advanceRecurring(reminder: Reminder, now: number): number | null {
    let cursor = reminder.nextDueUtc;

    for (let i = 0; i < 400; i++) {
      const proxima = this.nextDueAfter(reminder, cursor);
      if (proxima === null) {
        getLogger().error(
          {
            event: 'reminder_recurrence_unknown',
            reminder_id: reminder.id,
            room_id: reminder.roomId,
            repeat_rule: reminder.repeatRule,
          },
          'Sem regra de recorrência para rearmar o lembrete',
        );
        return null;
      }
      if (proxima <= cursor) {
        getLogger().error(
          {
            event: 'reminder_recurrence_stuck',
            reminder_id: reminder.id,
            repeat_rule: reminder.repeatRule,
          },
          'Recorrência não avançou: lembrete não pode ser rearmado',
        );
        return null;
      }
      cursor = proxima;
      if (cursor > now) return cursor;
    }

    return null;
  }
}
