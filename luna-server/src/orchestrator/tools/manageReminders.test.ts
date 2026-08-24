import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { ReminderStore } from '../../reminders/ReminderStore.js';
import type { ReminderScheduler } from '../../reminders/ReminderScheduler.js';
import { AlarmRinger, type BurstResult } from '../../reminders/AlarmRinger.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import { createManageRemindersHandler } from './manageReminders.js';
import type { ToolContext } from './types.js';

const silentConfig = { logLevel: 'silent' } as AppConfig;
const ROOM = 'sala_de_estar';
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
const MINUTO = 60_000;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    roomId: ROOM,
    deviceId: 'esp32-sala',
    provider: {} as IAudioProvider,
    callId: 'call-1',
    modelDecisionMs: null,
    ...overrides,
  };
}

interface Harness {
  store: ReminderStore;
  ringer: AlarmRinger;
  handler: ReturnType<typeof createManageRemindersHandler>;
  /** Põe um alarme tocando na sala, como o scheduler faria. */
  tocar: (label?: string | null) => Promise<{ id: number; shortId: string }>;
  cicloDoToque: Promise<void> | null;
}

describe('createManageRemindersHandler', () => {
  let h: Harness;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const store = ReminderStore.open(':memory:');
    const ringer = new AlarmRinger({
      store,
      sink: { ringBurst: (): BurstResult => 'delivered' },
      listenWindowMs: 6_000,
      maxRingMs: 5 * MINUTO,
      silentRetryMs: MINUTO,
      missedGraceMs: 15 * MINUTO,
      snoozeMaxMinutes: 60,
      fallbackRoomId: '',
      now: () => new Date(T0),
    });

    h = {
      store,
      ringer,
      handler: createManageRemindersHandler({
        ringer,
        store,
        getScheduler: () => ({ reschedule: () => {} }) as unknown as ReminderScheduler,
        now: () => new Date(T0),
      }),
      cicloDoToque: null,
      tocar: async (label = null) => {
        const criado = store.insertOnce({ roomId: ROOM, label, dueAtUtc: T0 }, T0);
        store.markRinging(criado.id, criado.nextDueUtc, T0);
        h.cicloDoToque = ringer.ring(store.get(criado.id)!);
        await Promise.resolve();
        return { id: criado.id, shortId: criado.shortId };
      },
    };
  });

  afterEach(async () => {
    h.ringer.stop();
    if (h.cicloDoToque) await h.cicloDoToque;
    mock.timers.reset();
    h.store.close();
  });

  it('dismiss para o alarme que toca nesta sala e o fecha no banco', async () => {
    const alarme = await h.tocar('tomar o remédio');

    const resultado = await h.handler({ action: 'dismiss' }, ctx());
    await h.cicloDoToque;

    assert.deepEqual(resultado, { success: true, dismissed: true, label: 'tomar o remédio' });
    assert.equal(h.store.get(alarme.id)!.status, 'done');
    assert.equal(h.ringer.isRinging(ROOM), false);
  });

  it('snooze adia e devolve os minutos que de fato foram aplicados', async () => {
    const alarme = await h.tocar();

    const resultado = await h.handler({ action: 'snooze', minutes: 5 }, ctx());
    await h.cicloDoToque;

    assert.deepEqual(resultado, {
      success: true,
      snoozed: true,
      minutes: 5,
      spoken_when: 'daqui a 5 minutos',
      label: null,
    });
    const depois = h.store.get(alarme.id)!;
    assert.equal(depois.status, 'armed');
    assert.equal(depois.nextDueUtc, T0 + 5 * MINUTO);
  });

  it('snooze sem minutos vira cinco', async () => {
    const alarme = await h.tocar();

    await h.handler({ action: 'snooze' }, ctx());
    await h.cicloDoToque;

    assert.equal(h.store.get(alarme.id)!.nextDueUtc, T0 + 5 * MINUTO);
  });

  it('snooze absurdo é clampado, e a fala confirma o valor aplicado, não o pedido', async () => {
    await h.tocar();

    const resultado = (await h.handler({ action: 'snooze', minutes: 9999 }, ctx())) as {
      minutes: number;
      spoken_when: string;
    };
    await h.cicloDoToque;

    assert.equal(resultado.minutes, 60);
    assert.equal(resultado.spoken_when, 'daqui a 60 minutos');
  });

  it('sem alarme tocando: erro falável, nunca uma confirmação inventada', async () => {
    const resultado = await h.handler({ action: 'dismiss' }, ctx());

    assert.deepEqual(resultado, {
      success: false,
      error: 'não tem nenhum alarme tocando aqui agora',
    });
  });

  it('alarme tocando em OUTRA sala não é dispensado daqui', async () => {
    const alarme = await h.tocar();

    const resultado = await h.handler({ action: 'dismiss' }, ctx({ roomId: 'cozinha' }));

    assert.equal((resultado as { success: boolean }).success, false);
    assert.equal(h.store.get(alarme.id)!.status, 'ringing');
    assert.equal(h.ringer.isRinging(ROOM), true);
  });

  it('args inválidos não tocam no alarme', async () => {
    const alarme = await h.tocar();

    const semAction = await h.handler({}, ctx());
    const actionInventada = await h.handler({ action: 'reschedule' }, ctx());
    const minutesTexto = await h.handler({ action: 'snooze', minutes: '5' }, ctx());

    for (const resultado of [semAction, actionInventada, minutesTexto]) {
      assert.deepEqual(resultado, { success: false, error: 'argumentos inválidos' });
    }
    assert.equal(h.store.get(alarme.id)!.status, 'ringing');
  });
});

describe('createManageRemindersHandler: list e cancel', () => {
  let store: ReminderStore;
  let ringer: AlarmRinger;
  let handler: ReturnType<typeof createManageRemindersHandler>;
  let rescheduleCalls: number;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    store = ReminderStore.open(':memory:');
    rescheduleCalls = 0;
    ringer = new AlarmRinger({
      store,
      sink: { ringBurst: (): BurstResult => 'delivered' },
      listenWindowMs: 6_000,
      maxRingMs: 5 * MINUTO,
      silentRetryMs: MINUTO,
      missedGraceMs: 15 * MINUTO,
      snoozeMaxMinutes: 60,
      fallbackRoomId: '',
      now: () => new Date(T0),
    });
    handler = createManageRemindersHandler({
      ringer,
      store,
      getScheduler: () =>
        ({
          reschedule: () => {
            rescheduleCalls += 1;
          },
        }) as unknown as ReminderScheduler,
      now: () => new Date(T0),
    });
  });

  afterEach(() => {
    store.close();
  });

  /** 12:00 UTC = 09:00 em São Paulo, então "às 20:00" é hoje mesmo. */
  function marcar(label: string | null, hora: number, minuto = 0): string {
    const dueAtUtc = T0 + ((hora - 9) * 60 + minuto) * MINUTO;
    return store.insertOnce({ roomId: ROOM, label, dueAtUtc }, T0).shortId;
  }

  it('list devolve os vivos em ordem de vencimento, com texto pronto para falar', async () => {
    marcar('tomar o remédio', 20);
    marcar(null, 18);

    const resultado = (await handler({ action: 'list' }, ctx())) as {
      count: number;
      spoken: string;
      reminders: Array<{ spoken_when: string; label: string | null }>;
    };

    assert.equal(resultado.count, 2);
    assert.deepEqual(
      resultado.reminders.map((r) => r.spoken_when),
      ['hoje às 18:00', 'hoje às 20:00'],
    );
    assert.equal(resultado.spoken, 'hoje às 18:00; tomar o remédio, hoje às 20:00');
  });

  it('list numa sala sem nada não é erro — é uma resposta falável', async () => {
    const resultado = (await handler({ action: 'list' }, ctx())) as {
      success: boolean;
      count: number;
      spoken: string;
    };

    assert.equal(resultado.success, true);
    assert.equal(resultado.count, 0);
    assert.equal(resultado.spoken, 'nenhum lembrete marcado aqui');
  });

  it('list de um recorrente diz a REGRA, não a próxima ocorrência', async () => {
    store.insertRecurring(
      {
        roomId: ROOM,
        label: 'academia',
        localHour: 6,
        localMinute: 30,
        repeatRule: 'weekdays',
        nextDueUtc: T0 + 24 * 60 * MINUTO,
      },
      T0,
    );

    const resultado = (await handler({ action: 'list' }, ctx())) as { spoken: string };

    // Quem marcou "todo dia útil às 6:30" espera ouvir isso de volta.
    assert.equal(resultado.spoken, 'academia, todo dia útil às 06:30');
  });

  it('cancel por horário acha o lembrete e o tira de circulação', async () => {
    const alvo = marcar('acordar', 7);
    marcar('jantar', 20);

    const resultado = (await handler({ action: 'cancel', at_time: '07:00' }, ctx())) as {
      success: boolean;
      reminder_id: string;
    };

    assert.equal(resultado.success, true);
    assert.equal(resultado.reminder_id, alvo);
    assert.equal(store.countLiveByRoom(ROOM), 1);
    assert.ok(rescheduleCalls > 0, 'cancelar muda quem é o próximo a vencer');
  });

  it('cancel por label ignora acento e caixa', async () => {
    marcar('tomar o remédio', 20);

    const resultado = (await handler({ action: 'cancel', label: 'REMEDIO' }, ctx())) as {
      success: boolean;
    };

    assert.equal(resultado.success, true);
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('cancel por id curto, como o list devolveu', async () => {
    const alvo = marcar('acordar', 7);
    marcar('jantar', 20);

    const resultado = (await handler({ action: 'cancel', reminder_id: alvo }, ctx())) as {
      success: boolean;
    };

    assert.equal(resultado.success, true);
    assert.equal(store.findByShortId(ROOM, alvo), null);
  });

  it('dois candidatos viram pergunta falada, e nada é cancelado no chute', async () => {
    marcar('remédio', 7);
    marcar('academia', 7);

    const resultado = (await handler({ action: 'cancel', at_time: '07:00' }, ctx())) as {
      success: boolean;
      error: string;
    };

    assert.equal(resultado.success, false);
    assert.match(resultado.error, /mais de um/);
    assert.match(resultado.error, /remédio/);
    assert.match(resultado.error, /academia/);
    // Cancelar o alarme errado só aparece na manhã seguinte, quando ninguém acorda.
    assert.equal(store.countLiveByRoom(ROOM), 2);
  });

  it('filtros combinam por E: "o do remédio das 8" não pega o remédio das 7', async () => {
    marcar('remédio', 7);
    const oitoHoras = marcar('remédio', 8);

    const resultado = (await handler(
      { action: 'cancel', at_time: '08:00', label: 'remédio' },
      ctx(),
    )) as { success: boolean; reminder_id: string };

    assert.equal(resultado.reminder_id, oitoHoras);
    assert.equal(store.countLiveByRoom(ROOM), 1);
  });

  it('cancel sem filtro com um só lembrete tem leitura única e funciona', async () => {
    marcar('acordar', 7);

    const resultado = (await handler({ action: 'cancel' }, ctx())) as { success: boolean };

    assert.equal(resultado.success, true);
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('cancel sem filtro com vários pede desambiguação', async () => {
    marcar('acordar', 7);
    marcar('jantar', 20);

    const resultado = (await handler({ action: 'cancel' }, ctx())) as {
      success: boolean;
      error: string;
    };

    assert.equal(resultado.success, false);
    assert.match(resultado.error, /qual/i);
    assert.equal(store.countLiveByRoom(ROOM), 2);
  });

  it('cancel que não acha nada devolve erro falável', async () => {
    marcar('acordar', 7);

    const resultado = (await handler({ action: 'cancel', at_time: '13:00' }, ctx())) as {
      success: boolean;
      error: string;
    };

    assert.equal(resultado.success, false);
    assert.equal(resultado.error, 'não achei nenhum lembrete assim');
    assert.equal(store.countLiveByRoom(ROOM), 1);
  });

  it('cancelar o que está tocando também para o toque', async () => {
    const criado = store.insertOnce({ roomId: ROOM, label: 'acordar', dueAtUtc: T0 }, T0);
    store.markRinging(criado.id, criado.nextDueUtc, T0);
    const ciclo = ringer.ring(store.get(criado.id)!);
    await Promise.resolve();
    assert.equal(ringer.isRinging(ROOM), true);

    await handler({ action: 'cancel', label: 'acordar' }, ctx());
    await ciclo;

    // Sem isto o alarme seguiria em rajadas até o teto, com o registro já
    // cancelado no banco.
    assert.equal(ringer.isRinging(ROOM), false);
    assert.equal(store.get(criado.id)!.status, 'cancelled');
  });

  it('lembretes de outra sala não aparecem nem são canceláveis daqui', async () => {
    store.insertOnce({ roomId: 'cozinha', label: 'forno', dueAtUtc: T0 + MINUTO }, T0);

    const listado = (await handler({ action: 'list' }, ctx())) as { count: number };
    const cancelado = (await handler({ action: 'cancel', label: 'forno' }, ctx())) as {
      success: boolean;
    };

    assert.equal(listado.count, 0);
    assert.equal(cancelado.success, false);
    assert.equal(store.countLiveByRoom('cozinha'), 1);
  });
});
