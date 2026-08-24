import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { ReminderStore } from '../../reminders/ReminderStore.js';
import { ReminderScheduler } from '../../reminders/ReminderScheduler.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import { createSetReminderHandler, MAX_LABEL_LENGTH } from './setReminder.js';
import type { ToolContext } from './types.js';

const silentConfig = { logLevel: 'silent' } as AppConfig;
const ROOM = 'sala_de_estar';
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0); // 2026-08-20 12:00 UTC = 09:00 em São Paulo

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

describe('createSetReminderHandler', () => {
  let store: ReminderStore;
  let scheduler: ReminderScheduler;
  let rescheduleCalls: number;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    store = ReminderStore.open(':memory:');
    rescheduleCalls = 0;
    scheduler = new ReminderScheduler({
      store,
      onFire: () => {},
      missedGraceMs: 15 * 60_000,
      maxRingMs: 5 * 60_000,
      maxConcurrent: 20,
      now: () => new Date(T0),
    });
    // Espiona reschedule() sem reimplementar o scheduler inteiro.
    const original = scheduler.reschedule.bind(scheduler);
    scheduler.reschedule = () => {
      rescheduleCalls += 1;
      original();
    };
  });

  afterEach(() => {
    scheduler.stop();
    store.close();
  });

  function handler(reminderMaxPerRoom = 20) {
    return createSetReminderHandler({
      store,
      getScheduler: () => scheduler,
      reminderMaxPerRoom,
      now: () => new Date(T0),
    });
  }

  it('cria um lembrete relativo, devolve short_id e nudge no scheduler', async () => {
    const result = (await handler()({ in_seconds: 600 }, ctx())) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.equal(typeof result.reminder_id, 'string');
    assert.match(result.spoken_when as string, /10 minutos/);
    assert.equal(result.label, null);
    assert.equal(rescheduleCalls, 1, 'reschedule() deveria ser chamado depois do insert');

    const live = store.listLiveByRoom(ROOM);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.dueAtUtc, T0 + 600_000);
  });

  it('cria um lembrete absoluto com label', async () => {
    const result = (await handler()(
      { label: 'tomar o remédio', at_time: '19:00' },
      ctx(),
    )) as Record<string, unknown>;

    assert.equal(result.success, true);
    assert.equal(result.label, 'tomar o remédio');
    assert.equal(result.spoken_when, 'hoje às 19:00');
  });

  it('args de forma inválida: "argumentos inválidos", sem tocar no banco', async () => {
    const result = await handler()({ in_seconds: '600' }, ctx());

    assert.deepEqual(result, { success: false, error: 'argumentos inválidos' });
    assert.equal(store.countLiveByRoom(ROOM), 0);
    assert.equal(rescheduleCalls, 0);
  });

  it('args semanticamente inválidos (resolveOnce rejeita): erro falável, sem tocar no banco', async () => {
    const result = await handler()({ in_seconds: 600, at_time: '19:00' }, ctx());

    assert.equal((result as { success: boolean }).success, false);
    assert.equal(store.countLiveByRoom(ROOM), 0);
    assert.equal(rescheduleCalls, 0);
  });

  it('rejeita label acima do limite de tamanho', async () => {
    const result = await handler()({ label: 'x'.repeat(MAX_LABEL_LENGTH + 1), in_seconds: 60 }, ctx());

    assert.equal((result as { success: boolean }).success, false);
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('rejeita label contendo a wake word, em qualquer caixa', async () => {
    for (const label of ['Luna, acorda', 'ping da LUNA', 'lunar', 'luna']) {
      const result = await handler()({ label, in_seconds: 60 }, ctx());
      assert.equal(
        (result as { success: boolean }).success,
        false,
        `"${label}" deveria ser rejeitado`,
      );
    }
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('label vazio ou só espaço vira null, não string vazia', async () => {
    const result = (await handler()({ label: '   ', in_seconds: 60 }, ctx())) as Record<
      string,
      unknown
    >;
    assert.equal(result.success, true);
    assert.equal(result.label, null);
  });

  it('teto de lembretes por sala: recusa o próximo sem tocar no banco', async () => {
    const h = handler(2);
    await h({ in_seconds: 60 }, ctx());
    await h({ in_seconds: 120 }, ctx());

    const result = await h({ in_seconds: 180 }, ctx());

    assert.equal((result as { success: boolean }).success, false);
    assert.equal(store.countLiveByRoom(ROOM), 2, 'não deveria ter inserido o terceiro');
  });

  it('o teto é por sala: outra sala não é afetada', async () => {
    const h = handler(1);
    await h({ in_seconds: 60 }, ctx());

    const outraSala = await h({ in_seconds: 60 }, ctx({ roomId: 'cozinha' }));

    assert.equal((outraSala as { success: boolean }).success, true);
  });

  it('o room_id dos args nunca é usado — quem decide é ctx.roomId (ADR 002)', async () => {
    await handler()(
      { in_seconds: 60, room_id: 'quarto' } as unknown as Record<string, unknown>,
      ctx(),
    );

    assert.equal(store.countLiveByRoom(ROOM), 1);
    assert.equal(store.countLiveByRoom('quarto'), 0);
  });
});

describe('createSetReminderHandler: recorrentes', () => {
  let store: ReminderStore;
  let scheduler: ReminderScheduler;

  before(() => {
    createLogger(silentConfig);
  });

  beforeEach(() => {
    store = ReminderStore.open(':memory:');
    scheduler = new ReminderScheduler({
      store,
      onFire: () => {},
      missedGraceMs: 15 * 60_000,
      maxRingMs: 5 * 60_000,
      maxConcurrent: 20,
      now: () => new Date(T0),
    });
  });

  afterEach(() => {
    scheduler.stop();
    store.close();
  });

  function handler() {
    return createSetReminderHandler({
      store,
      getScheduler: () => scheduler,
      reminderMaxPerRoom: 20,
      now: () => new Date(T0),
    });
  }

  it('"todo dia útil às 6:30" grava a regra e a hora local, não um instante', async () => {
    const resultado = (await handler()(
      { at_time: '06:30', repeat: 'weekdays', label: 'academia' },
      ctx(),
    )) as { success: boolean; spoken_when: string };

    assert.equal(resultado.success, true);
    assert.equal(resultado.spoken_when, 'todo dia útil às 06:30');

    const [criado] = store.listLiveByRoom(ROOM);
    assert.equal(criado!.kind, 'recurring');
    assert.equal(criado!.repeatRule, 'weekdays');
    assert.equal(criado!.localHour, 6);
    assert.equal(criado!.localMinute, 30);
    assert.equal(criado!.dueAtUtc, null);
    assert.ok(criado!.nextDueUtc > T0);
  });

  it('"toda sexta às 20h" vira repeat_rule = fri', async () => {
    await handler()({ at_time: '20:00', repeat: 'weekly', when_day: 'fri' }, ctx());

    const [criado] = store.listLiveByRoom(ROOM);
    assert.equal(criado!.kind, 'recurring');
    assert.equal(criado!.repeatRule, 'fri');
  });

  it('"sexta às 20h" sem repeat continua one-shot — é a distinção que o repeat existe para fazer', async () => {
    await handler()({ at_time: '20:00', when_day: 'fri' }, ctx());

    const [criado] = store.listLiveByRoom(ROOM);
    assert.equal(criado!.kind, 'once');
    assert.equal(criado!.repeatRule, null);
  });

  it('repeat none é explicitamente one-shot', async () => {
    await handler()({ at_time: '07:00', repeat: 'none' }, ctx());

    assert.equal(store.listLiveByRoom(ROOM)[0]!.kind, 'once');
  });

  it('repetir "daqui a tanto" não faz sentido e é rejeitado com erro falável', async () => {
    const resultado = (await handler()({ in_seconds: 600, repeat: 'daily' }, ctx())) as {
      success: boolean;
      error: string;
    };

    assert.equal(resultado.success, false);
    assert.match(resultado.error, /horário/);
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('weekly sem dia da semana devolve pergunta falável e não cria nada', async () => {
    const resultado = (await handler()({ at_time: '20:00', repeat: 'weekly' }, ctx())) as {
      success: boolean;
      error: string;
    };

    assert.equal(resultado.success, false);
    assert.equal(resultado.error, 'toda semana em qual dia?');
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });

  it('repeat fora do enum é argumento inválido, não é ignorado em silêncio', async () => {
    const resultado = await handler()({ at_time: '07:00', repeat: 'monthly' }, ctx());

    assert.deepEqual(resultado, { success: false, error: 'argumentos inválidos' });
    assert.equal(store.countLiveByRoom(ROOM), 0);
  });
});
