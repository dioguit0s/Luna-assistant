import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import type { CompassoClient, CompassoItem, CompassoList, CompassoResult } from './CompassoClient.js';
import { MAX_SPOKEN_ITEMS, queryAgenda } from './agendaQuery.js';
import { createGetAgendaHandler } from '../orchestrator/tools/getAgenda.js';

/** Sexta-feira, 25 de setembro de 2026, 10:00 em São Paulo. */
const NOW = new Date('2026-09-25T13:00:00Z');

function task(i: number): CompassoItem {
  return {
    id: `t${i}`,
    type: 'task',
    title: `Tarefa ${i}`,
    start: `2026-09-25T${String(8 + (i % 12)).padStart(2, '0')}:00:00-03:00`,
    end: null,
    all_day: false,
    location: null,
    recurring: false,
    occurrence_date: null,
    due: `2026-09-25T${String(8 + (i % 12)).padStart(2, '0')}:00:00-03:00`,
    done: false,
  };
}

function client(response: CompassoResult<CompassoList>, configured = true) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      configured,
      agenda: async (params: unknown) => {
        calls.push(params);
        return response;
      },
      pendingTasks: async () => response,
    } as unknown as CompassoClient,
  };
}

const ok = (items: CompassoItem[]): CompassoResult<CompassoList> => ({
  ok: true,
  status: 200,
  data: { timezone: 'America/Sao_Paulo', items, next_cursor: null },
});

describe('queryAgenda', () => {
  before(() => createLogger({ logLevel: 'silent' } as AppConfig));

  it('o payload é exatamente o que a tool devolve ao modelo', async () => {
    const items = [task(1), task(2)];
    const shared = await queryAgenda(client(ok(items)).client, { when: 'today' }, NOW);
    const tool = await createGetAgendaHandler({ client: client(ok(items)).client, now: () => NOW })(
      { when: 'today' },
      { roomId: 'quarto', deviceId: null, provider: {} as IAudioProvider, callId: 'c', modelDecisionMs: null },
    );
    assert.ok(shared.ok);
    assert.deepEqual(shared.payload, tool);
    assert.equal(shared.period, 'hoje, sexta, 25 de setembro');
    assert.equal(shared.items.length, 2);
    assert.equal(typeof shared.latencyMs, 'number');
  });

  it('acima do teto: o modelo vê os primeiros N e `more`, os itens crus vêm todos', async () => {
    const items = Array.from({ length: MAX_SPOKEN_ITEMS + 4 }, (_, i) => task(i));
    const outcome = await queryAgenda(client(ok(items)).client, { when: 'today' }, NOW);
    assert.ok(outcome.ok);
    assert.equal(outcome.payload.items.length, MAX_SPOKEN_ITEMS);
    assert.equal(outcome.payload.more, true);
    assert.equal(outcome.items.length, MAX_SPOKEN_ITEMS + 4);
  });

  it('desligada: não chama a rede e diz `not_configured`', async () => {
    const fake = client(ok([]), false);
    const outcome = await queryAgenda(fake.client, { when: 'today' }, NOW);
    assert.equal(outcome.ok, false);
    assert.equal(fake.calls.length, 0);
    if (!outcome.ok) {
      assert.equal(outcome.code, 'not_configured');
      assert.equal(outcome.latencyMs, null);
    }
  });

  it('falha do Compasso carrega o `error.code` e a frase falável', async () => {
    const outcome = await queryAgenda(
      client({ ok: false, status: 401, code: 'unauthorized', message: 'token novo', field: null }).client,
      { when: 'today' },
      NOW,
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, 'unauthorized');
      assert.deepEqual(outcome.payload, { success: false, error: 'token novo' });
      assert.equal(typeof outcome.latencyMs, 'number');
    }
  });

  it('args fora da semântica viram `invalid_range` sem rede', async () => {
    const fake = client(ok([]));
    const outcome = await queryAgenda(fake.client, { when: 'today', day_of_month: 3 }, NOW);
    assert.equal(outcome.ok, false);
    assert.equal(fake.calls.length, 0);
    if (!outcome.ok) assert.equal(outcome.code, 'invalid_range');
  });
});
