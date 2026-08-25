import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ReminderStore, type Reminder } from './ReminderStore.js';
import { AlarmRinger, type BurstResult } from './AlarmRinger.js';
import { CHIME_DURATION_MS } from './chime.js';

const silentConfig = { logLevel: 'silent' } as AppConfig;

const ROOM = 'sala_de_estar';
const FALLBACK = 'cozinha';
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
const MINUTO = 60_000;
const LISTEN_WINDOW_MS = 6_000;
const MAX_RING_MS = 5 * MINUTO;
const SILENT_RETRY_MS = 60_000;
const MISSED_GRACE_MS = 15 * MINUTO;
/** Mesmo default do `ringMaxDeferMs` em `config/env.ts`. */
const RING_MAX_DEFER_MS = 3_000;
/** Uma volta completa do ciclo: bipe inteiro + janela de escuta. */
const CICLO_MS = CHIME_DURATION_MS + LISTEN_WINDOW_MS;

/** Mesmo relógio controlável do `ReminderScheduler.test.ts`. */
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

/**
 * Sink falso: registra cada rajada e deixa o teste escolher o que ela devolve.
 * Usa o MESMO relógio fake do ringer — sem isso os dois lados subtrairiam
 * relógios diferentes e o teste mediria outra coisa.
 */
class FakeSink {
  readonly bursts: Array<{ roomId: string; at: number; force: boolean; hasSpeech: boolean }> = [];
  /** Resultado por cômodo; ausente = 'silent' (ninguém conectado ali). */
  readonly resultByRoom = new Map<string, BurstResult>([[ROOM, 'delivered']]);

  constructor(private readonly clock: ReturnType<typeof fakeClock>) {}

  ringBurst(roomId: string, force = false, speech: Buffer | null = null): BurstResult {
    const result = this.resultByRoom.get(roomId) ?? 'silent';
    // 'busy' não é entrega: não conta como rajada tocada.
    if (!(result === 'busy' && !force)) {
      this.bursts.push({
        roomId,
        at: this.clock.now().getTime(),
        force,
        hasSpeech: speech !== null && speech.length > 0,
      });
    }
    if (result === 'busy' && force) return 'delivered';
    return result;
  }

  burstsIn(roomId: string): number {
    return this.bursts.filter((b) => b.roomId === roomId).length;
  }
}

interface Harness {
  store: ReminderStore;
  sink: FakeSink;
  ringer: AlarmRinger;
  clock: ReturnType<typeof fakeClock>;
  rescheduleCalls: number;
}

const stores: ReminderStore[] = [];

function buildHarness(overrides: Record<string, unknown> = {}): Harness {
  const store = ReminderStore.open(':memory:');
  stores.push(store);
  const clock = fakeClock(T0);
  const sink = new FakeSink(clock);

  const ringer = new AlarmRinger({
    store,
    sink,
    listenWindowMs: LISTEN_WINDOW_MS,
    maxRingMs: MAX_RING_MS,
    silentRetryMs: SILENT_RETRY_MS,
    missedGraceMs: MISSED_GRACE_MS,
    maxDeferMs: RING_MAX_DEFER_MS,
    snoozeMaxMinutes: 60,
    fallbackRoomId: '',
    now: clock.now,
    ...overrides,
  });

  const h: Harness = { store, sink, ringer, clock, rescheduleCalls: 0 };
  // O ringer só usa `reschedule()` do scheduler: um dublê mínimo basta e
  // mantém o teste do ciclo independente do timer do scheduler.
  ringer.setScheduler({
    reschedule: () => {
      h.rescheduleCalls += 1;
    },
  } as unknown as Parameters<AlarmRinger['setScheduler']>[0]);

  return h;
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function advance(h: Harness, ms: number): Promise<void> {
  h.clock.tick(ms);
  await flushMicrotasks();
}

/**
 * Cria o lembrete e o põe em `ringing` como o `ReminderScheduler.fire` faria —
 * `markRinging` grava o status e avança `next_due_utc` ANTES de qualquer áudio
 * sair. O ringer recebe a linha já nesse estado.
 */
function armarEDisparar(
  h: Harness,
  opts: { label?: string | null; recurring?: boolean } = {},
): Reminder {
  const criado = opts.recurring
    ? h.store.insertRecurring(
        {
          roomId: ROOM,
          label: opts.label ?? null,
          localHour: 6,
          localMinute: 30,
          repeatRule: 'daily',
          nextDueUtc: T0,
        },
        T0,
      )
    : h.store.insertOnce({ roomId: ROOM, label: opts.label ?? null, dueAtUtc: T0 }, T0);

  const proxima = opts.recurring ? T0 + 24 * 60 * MINUTO : criado.nextDueUtc;
  h.store.markRinging(criado.id, proxima, T0);
  return h.store.get(criado.id)!;
}

describe('AlarmRinger', () => {
  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    while (stores.length > 0) stores.pop()!.close();
  });

  it('toca em rajadas com janela de escuta entre elas, não uma vez só', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    void h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.sink.burstsIn(ROOM), 1, 'a primeira rajada sai na hora');

    // No meio da janela ainda não saiu nada novo: é justamente aí que a wake
    // word está ligada e "Luna, para o alarme" tem onde ser ouvido.
    await advance(h, CICLO_MS - 1);
    assert.equal(h.sink.burstsIn(ROOM), 1);

    await advance(h, 1);
    assert.equal(h.sink.burstsIn(ROOM), 2);

    await advance(h, CICLO_MS);
    assert.equal(h.sink.burstsIn(ROOM), 3);

    h.ringer.dismiss(ROOM, 'tool');
  });

  it('dispensa por voz para o toque na hora e fecha o one-shot como done', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h, { label: 'tomar o remédio' });

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    await advance(h, CICLO_MS);
    assert.equal(h.sink.burstsIn(ROOM), 2);

    assert.equal(h.ringer.isRinging(ROOM), true);
    assert.deepEqual(h.ringer.ringingIn(ROOM), {
      shortId: reminder.shortId,
      label: 'tomar o remédio',
    });

    assert.equal(h.ringer.dismiss(ROOM, 'tool'), true);
    await ciclo;

    // ESTE é o bug que o marco 7 conserta: antes do AlarmRinger ninguém tirava
    // o lembrete de `ringing` em runtime — só o recoverStaleRinging do boot
    // seguinte.
    assert.equal(h.store.get(reminder.id)!.status, 'done');
    assert.equal(h.ringer.isRinging(ROOM), false);

    // E nada toca depois da dispensa, por mais que o relógio ande.
    await advance(h, CICLO_MS * 5);
    assert.equal(h.sink.burstsIn(ROOM), 2);
  });

  it('dispensa numa sala sem alarme é no-op silencioso', () => {
    const h = buildHarness();
    assert.equal(h.ringer.dismiss(ROOM, 'tool'), false);
    assert.equal(h.ringer.snooze(ROOM, 5).ok, false);
    assert.equal(h.ringer.ringingIn(ROOM), null);
  });

  it('recorrente volta para armed com o next_due_utc que markRinging já avançou', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h, { recurring: true });
    const proximaOcorrencia = reminder.nextDueUtc;

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;

    const depois = h.store.get(reminder.id)!;
    assert.equal(depois.status, 'armed');
    // Recalcular a recorrência aqui duplicaria a aritmética e daria drift: o
    // instante tem que ser exatamente o que o disparo já gravou.
    assert.equal(depois.nextDueUtc, proximaOcorrencia);
  });

  it('soneca rearma para o instante pedido e manda o scheduler rearmar o timer', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    const resultado = h.ringer.snooze(ROOM, 5);
    await ciclo;

    assert.deepEqual(resultado, {
      ok: true,
      minutes: 5,
      nextDueUtc: T0 + 5 * MINUTO,
    });
    const depois = h.store.get(reminder.id)!;
    assert.equal(depois.status, 'armed');
    assert.equal(depois.nextDueUtc, T0 + 5 * MINUTO);
    // Sem o reschedule, uma soneca de 1 minuto esperaria a acordada seguinte
    // do scheduler — a até MAX_TIMER_DELAY_MS (60s) de distância.
    assert.ok(h.rescheduleCalls > 0);
  });

  it('soneca é clampada no teto configurado', async () => {
    const h = buildHarness({ snoozeMaxMinutes: 60 });
    const reminder = armarEDisparar(h);
    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    const resultado = h.ringer.snooze(ROOM, 999);
    await ciclo;

    assert.equal(resultado.ok && resultado.minutes, 60);
  });

  it('teto de alarmMaxRingMs encerra o ciclo e fecha o lembrete', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    await advance(h, MAX_RING_MS);
    await ciclo;

    assert.equal(h.store.get(reminder.id)!.status, 'done');
    const rajadas = h.sink.burstsIn(ROOM);

    await advance(h, CICLO_MS * 3);
    assert.equal(h.sink.burstsIn(ROOM), rajadas, 'nada pode tocar depois do teto');
  });

  it('sala falando adia a rajada; passado o teto de adiamento, toca por cima', async () => {
    const h = buildHarness();
    h.sink.resultByRoom.set(ROOM, 'busy');
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.sink.burstsIn(ROOM), 0, 'nada sai por cima da fala do usuário');

    // Um cômodo que nunca silencia (o `--mic` do cliente de teste, o desktop)
    // não pode significar um alarme que nunca toca.
    // Um passo por vez: cada adiamento agenda o próximo, e `mock.timers.tick`
    // de um salto só não encadeia timer criado dentro de timer.
    for (let i = 0; i < 5; i++) await advance(h, 1_000);
    assert.ok(h.sink.burstsIn(ROOM) > 0, 'passado o teto, a rajada sai forçada');
    assert.ok(h.sink.bursts.some((b) => b.force), 'a rajada forçada é marcada como tal');

    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;
  });

  it('sala muda sem fallback: one-shot rearma para o futuro, nunca em laço quente', async () => {
    const h = buildHarness();
    h.sink.resultByRoom.set(ROOM, 'silent');
    const reminder = armarEDisparar(h);

    await h.ringer.ring(reminder);

    const depois = h.store.get(reminder.id)!;
    assert.equal(depois.status, 'armed');
    // Rearmar com o vencimento original faria o scheduler acordar com delay 0 e
    // redisparar milhares de vezes até a carência expirar.
    assert.equal(depois.nextDueUtc, T0 + SILENT_RETRY_MS);
    assert.ok(depois.nextDueUtc > T0);
  });

  it('sala muda por tempo demais: vira missed em vez de insistir para sempre', async () => {
    const h = buildHarness();
    h.sink.resultByRoom.set(ROOM, 'silent');
    const criado = h.store.insertOnce({ roomId: ROOM, label: null, dueAtUtc: T0 }, T0);
    h.store.markRinging(criado.id, criado.nextDueUtc, T0);

    // Já passou da carência: o retry cairia fora dela, então não há retry.
    const clockTardio = fakeClock(T0 + MISSED_GRACE_MS);
    const tardio = new AlarmRinger({
      store: h.store,
      sink: h.sink,
      listenWindowMs: LISTEN_WINDOW_MS,
      maxRingMs: MAX_RING_MS,
      silentRetryMs: SILENT_RETRY_MS,
      missedGraceMs: MISSED_GRACE_MS,
      maxDeferMs: RING_MAX_DEFER_MS,
    snoozeMaxMinutes: 60,
      fallbackRoomId: '',
      now: clockTardio.now,
    });

    await tardio.ring(h.store.get(criado.id)!);

    assert.equal(h.store.get(criado.id)!.status, 'missed');
  });

  it('origem muda na primeira rajada cai no cômodo de fallback, e a dispensa vale lá', async () => {
    const h = buildHarness({ fallbackRoomId: FALLBACK });
    h.sink.resultByRoom.set(ROOM, 'silent');
    h.sink.resultByRoom.set(FALLBACK, 'delivered');
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    assert.equal(h.sink.burstsIn(FALLBACK), 1);
    assert.equal(h.ringer.isRinging(FALLBACK), true);
    // O ciclo inteiro migrou: dispensar na origem não faz nada.
    assert.equal(h.ringer.isRinging(ROOM), false);
    assert.equal(h.ringer.dismiss(ROOM, 'tool'), false);

    assert.equal(h.ringer.dismiss(FALLBACK, 'tool'), true);
    await ciclo;
    assert.equal(h.store.get(reminder.id)!.status, 'done');
  });

  it('sala escurece no meio do ciclo: não pula de cômodo, rearma para tentar de novo', async () => {
    const h = buildHarness({ fallbackRoomId: FALLBACK });
    h.sink.resultByRoom.set(FALLBACK, 'delivered');
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.sink.burstsIn(ROOM), 1);

    // O satélite desconectou depois da primeira rajada.
    h.sink.resultByRoom.set(ROOM, 'silent');
    await advance(h, CICLO_MS);
    await ciclo;

    assert.equal(h.sink.burstsIn(FALLBACK), 0, 'alarme não persegue gente pela casa');
    assert.equal(h.store.get(reminder.id)!.status, 'armed');
  });

  it('um cancel durante o toque sobrevive ao fim do ciclo', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    // Chegou pela tool enquanto tocava.
    h.store.markStatus(reminder.id, 'cancelled', T0);
    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;

    assert.equal(
      h.store.get(reminder.id)!.status,
      'cancelled',
      'o fim do ciclo não pode sobrescrever um estado terminal já gravado',
    );
  });

  it('dispensa correndo com o teto resolve o ciclo uma vez só', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    assert.equal(h.ringer.dismiss(ROOM, 'tool'), true);
    assert.equal(h.ringer.dismiss(ROOM, 'turn_complete'), false);
    await ciclo;

    assert.equal(h.store.get(reminder.id)!.status, 'done');
  });

  it('stop() fecha o ciclo em voo e devolve o lembrete ao banco', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    h.ringer.stop();
    await ciclo;

    // Fechar escreve no banco — daí a ordem do shutdown em index.ts, com o
    // ringer parando ANTES de `reminderStore.close()`.
    assert.equal(h.store.get(reminder.id)!.status, 'armed');
    assert.equal(h.ringer.isRinging(ROOM), false);

    // Depois do stop, nada mais toca.
    const rajadas = h.sink.burstsIn(ROOM);
    await advance(h, CICLO_MS * 3);
    assert.equal(h.sink.burstsIn(ROOM), rajadas);
  });
});

describe('AlarmRinger: fala do lembrete', () => {
  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    while (stores.length > 0) stores.pop()!.close();
  });

  /** PCM de 2 s: 16 kHz, 2 bytes por amostra. */
  const FALA = Buffer.alloc(2 * 16_000 * 2);

  it('a primeira rajada leva a fala; as seguintes, só o bipe', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h, { label: 'tomar o remédio' });
    h.store.putAudio(reminder.id, FALA);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.sink.bursts[0]!.hasSpeech, true, 'a primeira rajada precisa dizer o quê');

    // Repetir a frase inteira a cada volta do ciclo é hostil.
    await advance(h, CICLO_MS + FALA.length / 2 / 16);
    assert.equal(h.sink.bursts[1]!.hasSpeech, false);

    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;
  });

  it('sem PCM renderizado o ciclo vira só-chime, sem erro nenhum', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h, { label: 'tomar o remédio' });
    // Nada de putAudio: é o caso de a pré-renderização ter falhado.

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    assert.equal(h.sink.bursts[0]!.hasSpeech, false);
    // Um alarme que bipa sempre vale mais que um que fala às vezes.
    assert.equal(h.sink.burstsIn(ROOM), 1);

    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;
  });

  it('a janela de escuta só começa depois de a fala terminar', async () => {
    const h = buildHarness();
    const reminder = armarEDisparar(h, { label: 'tomar o remédio' });
    h.store.putAudio(reminder.id, FALA);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    // Cortar a janela antes de o áudio terminar faria a rajada seguinte
    // atropelar a fala desta.
    await advance(h, CICLO_MS);
    assert.equal(h.sink.burstsIn(ROOM), 1, 'a fala de 2s ainda estava tocando');

    await advance(h, 2_000);
    assert.equal(h.sink.burstsIn(ROOM), 2);

    h.ringer.dismiss(ROOM, 'tool');
    await ciclo;
  });
});

describe('AlarmRinger: falha no meio do ciclo', () => {
  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    while (stores.length > 0) stores.pop()!.close();
  });

  it('exceção ao ler o áudio não prende a sala: o ciclo encerra e a promise resolve', async () => {
    // `speechForBurst` lê o banco de dentro do callback de `setTimeout`, fora de
    // qualquer catch. Sem proteção, uma exceção ali deixaria o ciclo órfão em
    // `activeByRoom` e a promise de `ring()` sem resolver PARA SEMPRE — o que
    // prende a vaga daquela sala em `firingRooms` do scheduler até o restart.
    const h = buildHarness();
    const reminder = armarEDisparar(h, { label: 'remédio' });

    h.store.getAudio = () => {
      throw new Error('database disk image is malformed');
    };

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();

    // A promise resolve — é ela que libera `firingRooms`.
    await ciclo;
    assert.equal(h.ringer.isRinging(ROOM), false);

    // E a sala volta a aceitar alarme: sem isso todo disparo seguinte cairia no
    // ramo `alarm_room_busy`.
    h.store.getAudio = () => null;
    const outro = armarEDisparar(h);
    const segundoCiclo = h.ringer.ring(outro);
    await flushMicrotasks();
    assert.equal(h.ringer.isRinging(ROOM), true);

    h.ringer.dismiss(ROOM, 'tool');
    await segundoCiclo;
  });

  it('exceção DENTRO do timer da rajada seguinte também encerra o ciclo', async () => {
    // O caminho que de fato prendia a sala para sempre: a exceção acontece no
    // callback do `setTimeout`, fora da call stack de `ring()`. Ali não há
    // promise para rejeitar — sem o try/catch vira `uncaughtException`, o ciclo
    // fica órfão em `activeByRoom` e a promise nunca resolve, segurando a vaga
    // em `firingRooms` até o restart.
    const h = buildHarness();
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.sink.burstsIn(ROOM), 1, 'a primeira rajada sai normalmente');

    // A segunda rajada, agendada por timer, é a que estoura.
    h.sink.ringBurst = () => {
      throw new Error('socket hang up');
    };

    await advance(h, CICLO_MS);
    await ciclo;

    assert.equal(h.ringer.isRinging(ROOM), false, 'o ciclo não pode ficar órfão');
    assert.equal(h.store.get(reminder.id)!.status, 'armed', 'one-shot que não tocou volta para retry');
  });
});

describe('AlarmRinger: recorrente que não tocou', () => {
  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    while (stores.length > 0) stores.pop()!.close();
  });

  it('sala muda não faz o recorrente pular a ocorrência de hoje sem tentar', async () => {
    // `markRinging` já avançou `next_due_utc` para amanhã. Devolver esse
    // instante significa perder a ocorrência de hoje sem uma tentativa sequer —
    // com uma falha determinística, o alarme diário simplesmente nunca tocaria.
    const h = buildHarness();
    h.sink.resultByRoom.set(ROOM, 'silent');
    const reminder = armarEDisparar(h, { recurring: true });
    const proximaOcorrencia = reminder.nextDueUtc;

    await h.ringer.ring(reminder);

    const depois = h.store.get(reminder.id)!;
    assert.equal(depois.status, 'armed');
    assert.equal(depois.nextDueUtc, T0 + SILENT_RETRY_MS, 'deveria retentar antes de amanhã');
    assert.ok(depois.nextDueUtc < proximaOcorrencia);
  });

  it('a retentativa nunca atropela a próxima ocorrência', async () => {
    // Recorrente de alta frequência: se o retry cair depois da próxima
    // ocorrência, ele a atrasaria em vez de antecipá-la.
    const h = buildHarness({ silentRetryMs: 10 * MINUTO });
    h.sink.resultByRoom.set(ROOM, 'silent');

    const criado = h.store.insertRecurring(
      {
        roomId: ROOM,
        label: null,
        localHour: 6,
        localMinute: 30,
        repeatRule: 'daily',
        nextDueUtc: T0,
      },
      T0,
    );
    const proxima = T0 + 2 * MINUTO; // próxima ocorrência bem antes do retry
    h.store.markRinging(criado.id, proxima, T0);

    await h.ringer.ring(h.store.get(criado.id)!);

    assert.equal(h.store.get(criado.id)!.nextDueUtc, proxima);
  });

  it('dispensa por short_id alcança o ciclo que migrou para o cômodo de fallback', async () => {
    // `dismiss` é por cômodo de propósito; `cancel` age à distância e precisa
    // achar o ciclo onde quer que ele esteja tocando.
    const h = buildHarness({ fallbackRoomId: FALLBACK });
    h.sink.resultByRoom.set(ROOM, 'silent');
    h.sink.resultByRoom.set(FALLBACK, 'delivered');
    const reminder = armarEDisparar(h);

    const ciclo = h.ringer.ring(reminder);
    await flushMicrotasks();
    assert.equal(h.ringer.isRinging(FALLBACK), true);

    // O cômodo da sessão é o de origem, onde nada está tocando.
    assert.equal(h.ringer.dismiss(ROOM, 'tool'), false);
    assert.equal(h.ringer.dismissByShortId(reminder.shortId), true);
    await ciclo;

    assert.equal(h.ringer.isRinging(FALLBACK), false);
    assert.equal(h.store.get(reminder.id)!.status, 'done');
  });

  it('dispensa por short_id de lembrete que não está tocando é no-op', () => {
    const h = buildHarness();
    assert.equal(h.ringer.dismissByShortId('A7K3'), false);
  });
});
