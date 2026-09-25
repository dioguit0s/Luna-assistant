import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import type { IAudioProvider } from '../../providers/IAudioProvider.js';
import type { CompassoClient, CompassoItem, CompassoResult, CompassoTask } from '../../calendar/CompassoClient.js';
import { createManageAgendaHandler } from './manageAgenda.js';
import { INVALID_ARGS_RESULT, type ToolContext } from './types.js';

/** Sexta-feira, 25 de setembro de 2026, 10:00 em São Paulo. */
const NOW = new Date('2026-09-25T13:00:00Z');

function ctx(callId = 'call-7'): ToolContext {
  return { roomId: 'quarto', deviceId: 'esp32', provider: {} as IAudioProvider, callId, modelDecisionMs: null };
}

type Call = { method: string; args: unknown[] };

/** Cliente falso: cada método devolve a próxima resposta da fila daquele método. */
function fakeClient(responses: Record<string, Array<CompassoResult<unknown>>>): {
  client: CompassoClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const method =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ method: name, args });
      const next = responses[name]?.shift();
      if (!next) throw new Error(`${name} não esperado`);
      return next;
    };
  const client = {
    configured: true,
    createEvent: method('createEvent'),
    createTask: method('createTask'),
    completeTask: method('completeTask'),
    pendingTasks: method('pendingTasks'),
    agenda: method('agenda'),
  } as unknown as CompassoClient;
  return { client, calls };
}

const ok = <T>(data: T, status = 201): CompassoResult<T> => ({ ok: true, status, data });
const list = (items: CompassoItem[]) => ok({ timezone: 'America/Sao_Paulo', items, next_cursor: null }, 200);

function task(overrides: Partial<CompassoTask> = {}): CompassoTask {
  return {
    id: 't1',
    type: 'task',
    title: 'Pagar a conta de luz',
    start: null,
    end: null,
    all_day: false,
    location: null,
    recurring: false,
    occurrence_date: null,
    due: null,
    done: false,
    ...overrides,
  };
}

describe('createManageAgendaHandler', () => {
  before(() => {
    createLogger({ logLevel: 'silent' } as AppConfig);
  });

  it('args inválidos devolvem INVALID_ARGS_RESULT', async () => {
    const { client } = fakeClient({});
    const result = await createManageAgendaHandler({ client, now: () => NOW })({ action: 'delete_event' }, ctx());
    assert.deepEqual(result, INVALID_ARGS_RESULT);
  });

  describe('create_event', () => {
    it('sexta às 14:30: ISO com offset, chave por call e confirmação pela resposta', async () => {
      const { client, calls } = fakeClient({
        createEvent: [
          ok({
            id: 'e1',
            type: 'event',
            title: 'Reunião do grupo',
            start: '2026-10-02T14:30:00-03:00',
            end: '2026-10-02T15:30:00-03:00',
            all_day: false,
            location: null,
            recurring: false,
            occurrence_date: null,
            conflicts: [],
          }),
        ],
      });
      const result = await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'create_event', title: 'Reunião do grupo', day_of_month: 2, at_time: '14:30' },
        ctx(),
      );

      assert.deepEqual(calls[0].args, [
        { title: 'Reunião do grupo', start: '2026-10-02T14:30:00-03:00' },
        'luna:quarto:event:call-7',
      ]);
      assert.deepEqual(result, {
        success: true,
        title: 'Reunião do grupo',
        spoken_when: 'dia 2 de outubro às 14:30',
      });
    });

    it('sem at_time é dia inteiro, com end = start; duração absurda é clampada', async () => {
      const created = { id: 'e', type: 'event', title: 'Viagem', start: '2026-09-26', end: '2026-09-26', all_day: true };
      const { client, calls } = fakeClient({ createEvent: [ok(created), ok({ ...created, all_day: false, start: '2026-09-25T18:00:00-03:00' })] });
      const handler = createManageAgendaHandler({ client, now: () => NOW });

      const allDay = (await handler({ action: 'create_event', title: 'Viagem', when_day: 'tomorrow' }, ctx())) as Record<string, unknown>;
      assert.deepEqual(calls[0].args[0], { title: 'Viagem', start: '2026-09-26', end: '2026-09-26', all_day: true });
      assert.equal(allDay.spoken_when, 'amanhã, dia inteiro');

      await handler({ action: 'create_event', title: 'Longa', at_time: '18:00', duration_minutes: 99999 }, ctx());
      assert.equal((calls[1].args[0] as Record<string, unknown>).duration_minutes, 720);
    });

    it('conflitos voltam em frase', async () => {
      const { client } = fakeClient({
        createEvent: [
          ok({
            id: 'e1',
            type: 'event',
            title: 'Reunião',
            start: '2026-09-25T14:00:00-03:00',
            end: '2026-09-25T15:00:00-03:00',
            all_day: false,
            conflicts: [
              { id: 'x', type: 'event', title: 'Dentista', start: '2026-09-25T14:00:00-03:00', end: '2026-09-25T14:45:00-03:00', all_day: false, location: null, recurring: false, occurrence_date: null },
            ],
          }),
        ],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'create_event', title: 'Reunião', at_time: '14:00' },
        ctx(),
      )) as Record<string, unknown>;
      assert.deepEqual(result.conflicts, ['Dentista, 14:00 às 14:45']);
    });

    it('sexta às 9 numa sexta às 10 vai para a sexta seguinte, como no set_reminder', async () => {
      const created = { id: 'e', type: 'event', title: 'Reunião', start: '2026-10-02T09:00:00-03:00', all_day: false };
      const { client, calls } = fakeClient({ createEvent: [ok(created)] });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'create_event', title: 'Reunião', when_day: 'fri', at_time: '09:00' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal((calls[0].args[0] as Record<string, unknown>).start, '2026-10-02T09:00:00-03:00');
      assert.equal(result.spoken_when, 'dia 2 de outubro às 09:00');
    });

    it('today com a hora passada não chama a API', async () => {
      const { client, calls } = fakeClient({});
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'create_event', title: 'Reunião', when_day: 'today', at_time: '08:00' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, false);
      assert.equal(calls.length, 0);
    });

    it('sem título não chama a API', async () => {
      const { client, calls } = fakeClient({});
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'create_event', title: '   ', at_time: '10:00' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, false);
      assert.equal(calls.length, 0);
    });
  });

  describe('create_task', () => {
    it('sem esforço ou atributo: pede, sem chamar a API', async () => {
      const { client, calls } = fakeClient({});
      const handler = createManageAgendaHandler({ client, now: () => NOW });

      const noEffort = (await handler({ action: 'create_task', title: 'Pagar', attribute: 'casa' }, ctx())) as Record<string, unknown>;
      assert.equal(noEffort.field, 'effort');
      const badEffort = (await handler({ action: 'create_task', title: 'Pagar', effort: 4, attribute: 'casa' }, ctx())) as Record<string, unknown>;
      assert.equal(badEffort.field, 'effort');
      const noAttr = (await handler({ action: 'create_task', title: 'Pagar', effort: 1 }, ctx())) as Record<string, unknown>;
      assert.equal(noAttr.field, 'attribute');
      assert.equal(calls.length, 0);
    });

    it('prazo por dia, por dia + hora, ou nenhum', async () => {
      const { client, calls } = fakeClient({
        createTask: [
          ok(task({ due: '2026-09-28' })),
          ok(task({ due: '2026-09-25T18:00:00-03:00' })),
          ok(task()),
        ],
      });
      const handler = createManageAgendaHandler({ client, now: () => NOW });
      const base = { action: 'create_task', title: 'Pagar a conta de luz', effort: 1, attribute: 'casa' };

      const byDay = (await handler({ ...base, when_day: 'mon' }, ctx())) as Record<string, unknown>;
      assert.equal((calls[0].args[0] as Record<string, unknown>).due, '2026-09-28');
      assert.equal(calls[0].args[1], 'luna:quarto:task:call-7');
      assert.equal(byDay.due, 'segunda');

      const byTime = (await handler({ ...base, at_time: '18:00' }, ctx())) as Record<string, unknown>;
      assert.equal((calls[1].args[0] as Record<string, unknown>).due, '2026-09-25T18:00:00-03:00');
      assert.equal(byTime.due, 'hoje até 18:00');

      const none = (await handler(base, ctx())) as Record<string, unknown>;
      assert.equal('due' in (calls[2].args[0] as Record<string, unknown>), false);
      assert.equal(none.due, 'sem prazo');
    });
  });

  describe('complete_task', () => {
    it('por task_id, repassando occurrence_date', async () => {
      const { client, calls } = fakeClient({ completeTask: [ok(task({ done: true }), 200)] });
      const result = await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', task_id: 't9', occurrence_date: '2026-09-25' },
        ctx(),
      );
      assert.deepEqual(calls[0].args, ['t9', '2026-09-25']);
      assert.deepEqual(result, { success: true, title: 'Pagar a conta de luz', done: true });
    });

    it('por título com um resultado só: conclui', async () => {
      const { client, calls } = fakeClient({
        pendingTasks: [list([task()])],
        completeTask: [ok(task({ done: true }), 200)],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'conta de luz' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, true);
      assert.deepEqual(calls[1].args, ['t1', undefined]);
    });

    it('recorrente só está na agenda: procura lá e deduplica as ocorrências', async () => {
      const occurrence = (date: string) =>
        task({ id: 'r1', title: 'Regar as plantas', recurring: true, occurrence_date: date, due: date });
      const { client, calls } = fakeClient({
        pendingTasks: [list([])],
        agenda: [list([occurrence('2026-09-25'), occurrence('2026-09-26'), occurrence('2026-09-27')])],
        completeTask: [ok(task({ id: 'r1', title: 'Regar as plantas', done: true }), 200)],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'regar plantas' },
        ctx(),
      )) as Record<string, unknown>;

      const agendaParams = calls[1].args[0] as Record<string, unknown>;
      assert.equal(agendaParams.from, '2026-09-25T00:00:00-03:00');
      assert.equal(agendaParams.to, '2026-10-02T00:00:00-03:00');
      assert.equal(agendaParams.types, 'task');
      assert.deepEqual(calls[2].args, ['r1', '2026-09-25']);
      assert.equal(result.success, true);
    });

    it('recorrente com a ocorrência de hoje já feita: não conclui a de amanhã', async () => {
      const occurrence = (date: string, done: boolean) =>
        task({ id: 'r1', title: 'Lavar a louça', recurring: true, occurrence_date: date, due: date, done });
      const { client, calls } = fakeClient({
        pendingTasks: [list([])],
        agenda: [list([occurrence('2026-09-25', true), occurrence('2026-09-26', false)])],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'louça' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, false);
      assert.match(String(result.error), /já está marcada como feita/);
      assert.equal(calls.filter((c) => c.method === 'completeTask').length, 0);
    });

    it('resposta fora do formato não lança', async () => {
      const { client } = fakeClient({
        pendingTasks: [ok({ timezone: 'America/Sao_Paulo' }, 200)],
        agenda: [ok({}, 200)],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'qualquer' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, false);
    });

    it('mais de uma: devolve candidatas e não conclui nenhuma', async () => {
      const { client, calls } = fakeClient({
        pendingTasks: [list([task({ id: 'a', title: 'Estudar física' }), task({ id: 'b', title: 'Estudar física II' })])],
      });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'estudar física' },
        ctx(),
      )) as { success: boolean; candidates: Array<Record<string, unknown>> };
      assert.equal(result.success, false);
      assert.deepEqual(
        result.candidates.map((c) => c.task_id),
        ['a', 'b'],
      );
      assert.equal(calls.filter((c) => c.method === 'completeTask').length, 0);
    });

    it('nenhuma: diz que não encontrou', async () => {
      const { client } = fakeClient({ pendingTasks: [list([])], agenda: [list([])] });
      const result = (await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', title: 'inexistente' },
        ctx(),
      )) as Record<string, unknown>;
      assert.equal(result.success, false);
      assert.match(String(result.error), /não encontrei/);
    });

    it('404 do Compasso vira "não encontrei essa tarefa"', async () => {
      const { client } = fakeClient({
        completeTask: [{ ok: false, status: 404, code: 'not_found', message: 'Evento não se conclui.', field: null }],
      });
      const result = await createManageAgendaHandler({ client, now: () => NOW })(
        { action: 'complete_task', task_id: 'e1' },
        ctx(),
      );
      assert.deepEqual(result, { success: false, error: 'não encontrei essa tarefa' });
    });
  });
});
