import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import type { CompassoClient, CompassoItem, CompassoResult, CompassoList } from '../../calendar/CompassoClient.js';
import { createGetAgendaHandler, MAX_SPOKEN_ITEMS } from './getAgenda.js';
import { INVALID_ARGS_RESULT, type ToolContext } from './types.js';

/** Sexta-feira, 25 de setembro de 2026, 10:00 em São Paulo. */
const NOW = new Date('2026-09-25T13:00:00Z');

function ctx(): ToolContext {
  return { roomId: 'quarto', deviceId: 'esp32', provider: {} as IAudioProvider, callId: 'c1', modelDecisionMs: 120 };
}

const ITEMS: CompassoItem[] = [
  { id: 'e1', type: 'event', title: 'Aniversário da Ana', start: '2026-09-26', end: '2026-09-26', all_day: true, location: null, recurring: false, occurrence_date: null },
  { id: 'e2', type: 'event', title: 'Treino\nna academia', start: '2026-09-26T07:00:00-03:00', end: '2026-09-26T08:00:00-03:00', all_day: false, location: null, recurring: true, occurrence_date: '2026-09-26' },
  { id: 'c1', type: 'class', title: 'Cálculo II', start: '2026-09-26T08:00:00-03:00', end: '2026-09-26T10:00:00-03:00', all_day: false, location: 'B-204', recurring: true, occurrence_date: '2026-09-26', subject: 'Cálculo II', professor: 'Marcos Lima', cancelled: true },
  { id: 't1', type: 'task', title: 'Entregar relatório', start: '2026-09-26T23:59:00-03:00', end: null, all_day: false, location: null, recurring: false, occurrence_date: null, due: '2026-09-26T23:59:00-03:00', done: false },
];

type Calls = Array<{ method: string; params: unknown }>;

function fakeClient(
  response: CompassoResult<CompassoList>,
  configured = true,
): { client: CompassoClient; calls: Calls } {
  const calls: Calls = [];
  const client = {
    configured,
    agenda: async (params: unknown) => {
      calls.push({ method: 'agenda', params });
      return response;
    },
    pendingTasks: async (params: unknown) => {
      calls.push({ method: 'pendingTasks', params });
      return response;
    },
  } as unknown as CompassoClient;
  return { client, calls };
}

const ok = (items: CompassoItem[], next_cursor: string | null = null): CompassoResult<CompassoList> => ({
  ok: true,
  status: 200,
  data: { timezone: 'America/Sao_Paulo', items, next_cursor },
});

describe('createGetAgendaHandler', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('args inválidos devolvem INVALID_ARGS_RESULT', async () => {
    const { client } = fakeClient(ok([]));
    const handler = createGetAgendaHandler({ client, now: () => NOW });
    assert.deepEqual(await handler({ when: '2026-09-26' }, ctx()), INVALID_ARGS_RESULT);
  });

  it('agenda desligada responde sem rede', async () => {
    const { client, calls } = fakeClient(ok([]), false);
    const result = (await createGetAgendaHandler({ client, now: () => NOW })({}, ctx())) as Record<string, unknown>;
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
  });

  it('amanhã: intervalo resolvido pelo servidor e itens prontos para falar', async () => {
    const { client, calls } = fakeClient(ok(ITEMS));
    const handler = createGetAgendaHandler({ client, now: () => NOW });
    const result = (await handler({ when: 'tomorrow' }, ctx())) as Record<string, unknown>;

    assert.deepEqual(calls[0], {
      method: 'agenda',
      params: {
        from: '2026-09-26T00:00:00-03:00',
        to: '2026-09-27T00:00:00-03:00',
        types: undefined,
        q: undefined,
        limit: 50,
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.period, 'amanhã, sábado, 26 de setembro');
    assert.equal(result.more, undefined);
    assert.deepEqual(result.items, [
      { type: 'compromisso', title: 'Aniversário da Ana', time: 'dia inteiro' },
      { type: 'compromisso', title: 'Treino na academia', time: '07:00 às 08:00' },
      { type: 'aula', title: 'Cálculo II', time: '08:00 às 10:00', room: 'B-204', professor: 'Marcos Lima', cancelled: true },
      { type: 'tarefa', title: 'Entregar relatório', time: 'até 23:59', done: false, task_id: 't1' },
    ]);
  });

  it('período de vários dias diz o dia de cada item', async () => {
    const { client } = fakeClient(ok(ITEMS.slice(1, 2)));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })({ when: 'week' }, ctx())) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(result.items[0].day, 'amanhã');
  });

  it('search sem when procura nos próximos meses, filtrando por tipo', async () => {
    const { client, calls } = fakeClient(ok([]));
    await createGetAgendaHandler({ client, now: () => NOW })({ search: 'prova cálculo', kind: 'events' }, ctx());
    const params = calls[0].params as Record<string, unknown>;
    assert.equal(params.from, '2026-09-25T00:00:00-03:00');
    assert.equal(params.to, '2027-03-24T00:00:00-03:00');
    assert.equal(params.types, 'event');
    assert.equal(params.q, 'prova cálculo');
  });

  it('pending_tasks usa /tasks e ignora when', async () => {
    const { client, calls } = fakeClient(ok([]));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })(
      { kind: 'pending_tasks', when: 'tomorrow' },
      ctx(),
    )) as Record<string, unknown>;
    assert.equal(calls[0].method, 'pendingTasks');
    assert.equal(result.period, 'tarefas pendentes');
    assert.deepEqual(result.items, []);
  });

  it('corta em MAX_SPOKEN_ITEMS e sinaliza more; next_cursor também é more', async () => {
    const many = Array.from({ length: MAX_SPOKEN_ITEMS + 3 }, (_, i) => ({ ...ITEMS[1], id: `e${i}` }));
    const { client } = fakeClient(ok(many));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })({}, ctx())) as {
      items: unknown[];
      more?: boolean;
    };
    assert.equal(result.items.length, MAX_SPOKEN_ITEMS);
    assert.equal(result.more, true);

    const paged = fakeClient(ok(ITEMS.slice(0, 1), 'cursor-2'));
    const second = (await createGetAgendaHandler({ client: paged.client, now: () => NOW })({}, ctx())) as {
      more?: boolean;
    };
    assert.equal(second.more, true);
  });

  it('falha do Compasso vira frase falável', async () => {
    const { client } = fakeClient({
      ok: false,
      status: null,
      code: 'unreachable',
      message: 'o Compasso não respondeu agora',
      field: null,
    });
    const result = await createGetAgendaHandler({ client, now: () => NOW })({}, ctx());
    assert.deepEqual(result, { success: false, error: 'o Compasso não respondeu agora' });
  });

  it('dia do mês inválido não chega à rede', async () => {
    const { client, calls } = fakeClient(ok([]));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })({ day_of_month: 40 }, ctx())) as Record<
      string,
      unknown
    >;
    assert.equal(result.success, false);
    assert.equal(calls.length, 0);
  });

  it('busca com dia do mês procura só naquele dia', async () => {
    const { client, calls } = fakeClient(ok([]));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })(
      { search: 'prova cálculo', day_of_month: 30 },
      ctx(),
    )) as Record<string, unknown>;
    assert.equal(result.success, true);
    const params = calls[0].params as Record<string, unknown>;
    assert.equal(params.from, '2026-09-30T00:00:00-03:00');
    assert.equal(params.to, '2026-10-01T00:00:00-03:00');
  });

  it('tarefa sem start diz o dia pelo prazo', async () => {
    const semStart = { ...ITEMS[3], start: null, due: '2026-09-29T18:00:00-03:00' } as CompassoItem;
    const { client } = fakeClient(ok([semStart]));
    const result = (await createGetAgendaHandler({ client, now: () => NOW })({ when: 'week' }, ctx())) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(result.items[0].day, 'terça');
    assert.equal(result.items[0].time, 'até 18:00');
  });
});
