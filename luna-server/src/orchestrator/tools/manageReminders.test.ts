import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { ReminderStore } from '../../reminders/ReminderStore.js';
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
      handler: createManageRemindersHandler({ ringer }),
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
    const actionInventada = await h.handler({ action: 'cancel' }, ctx());
    const minutesTexto = await h.handler({ action: 'snooze', minutes: '5' }, ctx());

    for (const resultado of [semAction, actionInventada, minutesTexto]) {
      assert.deepEqual(resultado, { success: false, error: 'argumentos inválidos' });
    }
    assert.equal(h.store.get(alarme.id)!.status, 'ringing');
  });
});
