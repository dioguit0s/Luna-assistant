import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ReminderStore, type Reminder } from './ReminderStore.js';
import { ReminderScheduler, MAX_TIMER_DELAY_MS } from './ReminderScheduler.js';

const silentConfig = { logLevel: 'silent' } as AppConfig;

const ROOM = 'sala_de_estar';
const OUTRA_SALA = 'cozinha';
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const MISSED_GRACE_MS = 15 * MINUTO;
const MAX_RING_MS = 5 * MINUTO;

/**
 * Relógio controlável a partir de `mock.timers`: cada `tick` avança tanto o
 * `setTimeout` real (fake) quanto o valor que `now()` devolve, mantendo os
 * dois em sincronia — é o que `nowFn` injetável promete.
 */
function fakeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    tick(ms: number): void {
      current += ms;
      mock.timers.tick(ms);
    },
  };
}

/** Todo lembrete recorrente do teste "toda hora, no minuto redondo" — simples e determinístico. */
const nextHourly: (reminder: Reminder, after: number) => number | null = (_reminder, after) =>
  after + HORA;

interface Harness {
  store: ReminderStore;
  scheduler: ReminderScheduler;
  fired: Reminder[];
  clock: ReturnType<typeof fakeClock>;
}

function buildHarness(overrides: Partial<ConstructorParameters<typeof ReminderScheduler>[0]> = {}): Harness {
  const store = ReminderStore.open(':memory:');
  const clock = fakeClock(T0);
  const fired: Reminder[] = [];

  const scheduler = new ReminderScheduler({
    store,
    onFire: (reminder) => {
      fired.push(reminder);
    },
    missedGraceMs: MISSED_GRACE_MS,
    maxRingMs: MAX_RING_MS,
    maxConcurrent: 20,
    now: clock.now,
    nextDueAfter: nextHourly,
    ...overrides,
  });

  return { store, scheduler, fired, clock };
}

/** Promise controlável de fora: sem a narrowing esquisita de `let` capturado em closure. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => resolve();
  });
  return { promise, resolve: resolveFn };
}

/**
 * O disparo passa por `Promise.resolve().then(...)` dentro do scheduler — uma
 * volta de microtask depois do `setTimeout` (fake) disparar, o sink ainda não
 * rodou. Várias voltas cobrem o `.then().catch().finally()` inteiro.
 */
async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Avança o relógio fake e dá tempo do disparo (assíncrono) assentar. */
async function advance(h: Harness, ms: number): Promise<void> {
  h.clock.tick(ms);
  await flushMicrotasks();
}

describe('ReminderScheduler', () => {
  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('dispara no vencimento e o timer nunca segura o processo', async () => {
    const h = buildHarness();
    const criado = h.store.insertOnce({ roomId: ROOM, label: 'café', dueAtUtc: T0 + MINUTO }, T0);

    h.scheduler.start();
    await advance(h, MINUTO);

    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]!.id, criado.id);
    assert.equal(h.store.get(criado.id)!.status, 'ringing');
    h.scheduler.stop();
  });

  it('clampa em MAX_TIMER_DELAY_MS: um lembrete daqui a 2h acorda em pedaços de 60s', async () => {
    const h = buildHarness();
    h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + 2 * HORA }, T0);

    h.scheduler.start();

    // Menos de uma acordada: nada dispara ainda.
    await advance(h, MAX_TIMER_DELAY_MS - 1);
    assert.equal(h.fired.length, 0);

    // Precisa de 2h / 60s acordadas para vencer — nenhuma delas atrasa o
    // relógio, cada uma só reagenda a próxima com o delay já corrigido.
    const acordadasRestantes = Math.ceil((2 * HORA) / MAX_TIMER_DELAY_MS);
    await advance(h, acordadasRestantes * MAX_TIMER_DELAY_MS);

    assert.equal(h.fired.length, 1);
    h.scheduler.stop();
  });

  it('dois lembretes na mesma acordada disparam os dois', async () => {
    const h = buildHarness();
    h.store.insertOnce({ roomId: ROOM, label: 'a', dueAtUtc: T0 + MINUTO }, T0);
    h.store.insertOnce({ roomId: OUTRA_SALA, label: 'b', dueAtUtc: T0 + MINUTO }, T0);

    h.scheduler.start();
    await advance(h, MINUTO);

    assert.equal(h.fired.length, 2);
    assert.deepEqual(
      h.fired.map((r) => r.roomId).sort(),
      [OUTRA_SALA, ROOM],
    );
    h.scheduler.stop();
  });

  it('reschedule() percebe um lembrete criado depois de start() sem esperar a acordada seguinte', async () => {
    // Sem reschedule() explícito, um lembrete "daqui a 10s" criado logo após
    // start() (que armou o timer para o vencimento anterior, mais distante)
    // esperaria até 60s a mais que o pedido.
    const h = buildHarness();
    h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + HORA }, T0);
    h.scheduler.start();

    h.store.insertOnce({ roomId: OUTRA_SALA, label: null, dueAtUtc: T0 + 10_000 }, T0);
    h.scheduler.reschedule();

    await advance(h, 10_000);

    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]!.roomId, OUTRA_SALA);
    h.scheduler.stop();
  });

  describe('catch-up e vencido-no-boot', () => {
    it('dentro da carência: toca mesmo atrasado', async () => {
      const h = buildHarness();
      const criado = h.store.insertOnce(
        { roomId: ROOM, label: null, dueAtUtc: T0 - (MISSED_GRACE_MS - MINUTO) },
        T0 - HORA,
      );

      h.scheduler.start();
      // Já vencido no boot: o timer arma com delay 0, precisa da acordada.
      await advance(h, 0);

      assert.equal(h.fired.length, 1);
      assert.equal(h.fired[0]!.id, criado.id);
      h.scheduler.stop();
    });

    it('além da carência: vira missed, sem tocar — o alarme das 6:30 não dispara às 9:30', async () => {
      const h = buildHarness();
      const criado = h.store.insertOnce(
        { roomId: ROOM, label: null, dueAtUtc: T0 - (MISSED_GRACE_MS + MINUTO) },
        T0 - 4 * HORA,
      );

      h.scheduler.start();
      await advance(h, 0);

      assert.equal(h.fired.length, 0);
      assert.equal(h.store.get(criado.id)!.status, 'missed');
      h.scheduler.stop();
    });

    it('recorrente além da carência: avança sem tocar, colapsando o catch-up numa ocorrência', async () => {
      // Três horas perdidas não podem despejar três disparos de uma vez.
      const h = buildHarness();
      const criado = h.store.insertRecurring(
        {
          roomId: ROOM,
          label: null,
          localHour: 7,
          localMinute: 0,
          repeatRule: 'daily',
          nextDueUtc: T0 - 3 * HORA,
        },
        T0 - 4 * HORA,
      );

      h.scheduler.start();
      await advance(h, 0);

      assert.equal(h.fired.length, 0);
      const depois = h.store.get(criado.id)!;
      assert.equal(depois.status, 'armed');
      assert.ok(depois.nextDueUtc > T0, 'deveria ter avançado para o futuro');

      await advance(h, depois.nextDueUtc - T0);
      assert.equal(h.fired.length, 1);
      h.scheduler.stop();
    });

    it('boot com ringing recente (< maxRingMs): não mexe, um toque em andamento pode continuar', () => {
      const h = buildHarness();
      const criado = h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
      h.store.markRinging(criado.id, T0, T0 - MINUTO);

      h.scheduler.start();

      assert.equal(h.store.get(criado.id)!.status, 'ringing');
      h.scheduler.stop();
    });

    it('boot com ringing velho (> maxRingMs): recupera antes de agendar qualquer coisa', () => {
      // O crash no meio do toque não pode fazer o one-shot re-disparar a cada boot.
      const h = buildHarness();
      const oneShot = h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
      h.store.markRinging(oneShot.id, T0, T0 - (MAX_RING_MS + MINUTO));

      h.scheduler.start();

      assert.equal(h.store.get(oneShot.id)!.status, 'done');
      assert.equal(h.fired.length, 0);
      h.scheduler.stop();
    });
  });

  describe('idempotência a crash', () => {
    it('markRinging já aconteceu antes do sink ser chamado', async () => {
      // Sem isso, um crash entre o disparo e o registro re-tocaria o one-shot
      // a cada boot. Grava o status observado em vez de fazer assert dentro do
      // sink: uma falha ali seria engolida pelo `.catch` do scheduler e o
      // teste passaria mesmo se a asserção estivesse errada.
      const statusObservadoNoSink: string[] = [];
      const h = buildHarness({
        onFire: (reminder) => {
          statusObservadoNoSink.push(h.store.get(reminder.id)!.status);
        },
      });
      h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + MINUTO }, T0);

      h.scheduler.start();
      await advance(h, MINUTO);

      assert.deepEqual(statusObservadoNoSink, ['ringing']);
      h.scheduler.stop();
    });

    it('sink que lança não trava o cômodo nem derruba o processo', async () => {
      const h = buildHarness({
        onFire: () => {
          throw new Error('provider indisponível');
        },
      });
      const criado = h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + MINUTO }, T0);
      h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + MINUTO + 1 }, T0);

      h.scheduler.start();
      await advance(h, MINUTO);

      assert.equal(h.store.get(criado.id)!.status, 'ringing');
      h.scheduler.stop();
    });
  });

  describe('teto de disparos simultâneos', () => {
    it('não abre mais que maxConcurrent sessões ao mesmo tempo', () => {
      const h = buildHarness();
      const { promise: pendente, resolve: liberar } = deferred();

      const scheduler = new ReminderScheduler({
        store: h.store,
        onFire: () => pendente,
        missedGraceMs: MISSED_GRACE_MS,
        maxRingMs: MAX_RING_MS,
        maxConcurrent: 1,
        now: h.clock.now,
        nextDueAfter: nextHourly,
      });

      h.store.insertOnce({ roomId: ROOM, label: 'a', dueAtUtc: T0 + MINUTO }, T0);
      h.store.insertOnce({ roomId: OUTRA_SALA, label: 'b', dueAtUtc: T0 + MINUTO }, T0);

      scheduler.start();
      h.clock.tick(MINUTO);

      // Um continua armed — não coube no teto desta acordada.
      const status = [ROOM, OUTRA_SALA].map((room) => h.store.listLiveByRoom(room)[0]!.status);
      assert.deepEqual(status.sort(), ['armed', 'ringing']);

      liberar();
      scheduler.stop();
    });

    it('não dispara duas vezes o mesmo cômodo enquanto o toque dele está em voo', () => {
      const h = buildHarness();
      const { promise: pendente, resolve: liberar } = deferred();
      const scheduler = new ReminderScheduler({
        store: h.store,
        onFire: () => pendente,
        missedGraceMs: MISSED_GRACE_MS,
        maxRingMs: MAX_RING_MS,
        maxConcurrent: 20,
        now: h.clock.now,
        nextDueAfter: nextHourly,
      });

      const primeiro = h.store.insertOnce({ roomId: ROOM, label: 'a', dueAtUtc: T0 + MINUTO }, T0);
      const segundo = h.store.insertOnce({ roomId: ROOM, label: 'b', dueAtUtc: T0 + MINUTO }, T0);

      scheduler.start();
      h.clock.tick(MINUTO);

      const statusPrimeiro = h.store.get(primeiro.id)!.status;
      const statusSegundo = h.store.get(segundo.id)!.status;
      assert.deepEqual([statusPrimeiro, statusSegundo].sort(), ['armed', 'ringing']);

      liberar();
      scheduler.stop();
    });
  });

  it('stop() é idempotente e cancela o timer pendente', () => {
    const h = buildHarness();
    h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 + MINUTO }, T0);

    h.scheduler.start();
    h.scheduler.stop();
    h.scheduler.stop();

    h.clock.tick(MINUTO);
    assert.equal(h.fired.length, 0, 'não deveria disparar depois de stop()');
  });
});
