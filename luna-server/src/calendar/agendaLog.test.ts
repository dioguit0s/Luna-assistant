import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ReminderStore } from '../reminders/ReminderStore.js';
import { DiagnosticsStore, MAX_ROWS, RETENTION_MS } from '../diagnostics/DiagnosticsStore.js';
import { deferredAgendaSink, loggableInt, type AgendaLogEntry } from './agendaLog.js';

function entry(partial: Partial<AgendaLogEntry> = {}): AgendaLogEntry {
  return {
    at: 1_000,
    roomId: 'quarto',
    tool: 'get_agenda',
    action: 'query',
    when: 'tomorrow',
    dayOfMonth: null,
    kind: 'all',
    effort: null,
    attribute: null,
    hasSearch: false,
    result: 'ok',
    itemCount: 3,
    itemId: null,
    latencyMs: 42,
    ...partial,
  };
}

function setup(now?: () => number) {
  const reminders = ReminderStore.open(':memory:');
  const db = reminders.sharedDatabase();
  return { db, store: new DiagnosticsStore(db, now) };
}

describe('agenda_events (DiagnosticsStore)', () => {
  before(() => createLogger({ logLevel: 'silent' } as AppConfig));

  it('grava e lê de volta, mais recente primeiro', () => {
    const { store } = setup();
    store.insertAgendaEvent(entry({ at: 1_000 }));
    store.insertAgendaEvent(
      entry({
        at: 2_000,
        tool: 'manage_agenda',
        action: 'create_task',
        when: null,
        kind: null,
        effort: 3,
        attribute: 'casa',
        result: 'ok',
        itemCount: null,
        itemId: 'tsk_1',
      }),
    );
    store.insertAgendaEvent(entry({ at: 3_000, result: 'unreachable', itemCount: null, latencyMs: 2001.6, hasSearch: true }));

    const rows = store.agendaHistory(10);
    assert.deepEqual(rows.map((r) => r.at), [3_000, 2_000, 1_000]);
    assert.equal(rows[0]!.result, 'unreachable');
    assert.equal(rows[0]!.latencyMs, 2002);
    assert.equal(rows[0]!.hasSearch, true);
    assert.equal(rows[1]!.effort, 3);
    assert.equal(rows[1]!.attribute, 'casa');
    assert.equal(rows[1]!.itemId, 'tsk_1');
    assert.equal(store.agendaHistory(1).length, 1);
  });

  it('a tabela não tem coluna para texto livre', () => {
    const { db } = setup();
    const columns = (db.prepare('PRAGMA table_info(agenda_events)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const forbidden of ['search', 'title', 'text', 'query', 'args']) {
      assert.ok(!columns.includes(forbidden), `coluna ${forbidden} não deveria existir`);
    }
  });

  it('retenção: 30 dias ou 10 mil linhas, como as outras tabelas', () => {
    const clock = 10 * RETENTION_MS;
    const { db, store } = setup(() => clock);
    store.insertAgendaEvent(entry({ at: clock - RETENTION_MS - 1 }));
    const insert = db.prepare("INSERT INTO agenda_events (at, room_id, tool, result) VALUES (?, 'q', 'get_agenda', 'ok')");
    for (let i = 0; i < MAX_ROWS + 25; i++) insert.run(clock);
    store.prune();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM agenda_events').get() as { n: number }).n;
    const oldest = (db.prepare('SELECT MIN(at) AS at FROM agenda_events').get() as { at: number }).at;
    assert.equal(Number(count), MAX_ROWS);
    assert.equal(Number(oldest), clock, 'a linha velha saiu');
  });
});

describe('deferredAgendaSink', () => {
  before(() => createLogger({ logLevel: 'silent' } as AppConfig));

  it('não grava na mesma volta do event loop', async () => {
    const written: AgendaLogEntry[] = [];
    const sink = deferredAgendaSink((e) => written.push(e));
    sink.record(entry());
    assert.equal(written.length, 0, 'a resposta da tool sai antes do INSERT');
    await new Promise((r) => setImmediate(r));
    assert.equal(written.length, 1);
  });

  it('erro de escrita não lança nem derruba o processo', async () => {
    const sink = deferredAgendaSink(() => {
      throw new Error('disk I/O error');
    });
    assert.doesNotThrow(() => sink.record(entry()));
    await new Promise((r) => setImmediate(r));
  });
});

describe('loggableInt', () => {
  it('só inteiro na faixa', () => {
    assert.equal(loggableInt(30, 1, 31), 30);
    assert.equal(loggableInt(3.5, 1, 31), null);
    assert.equal(loggableInt(99, 1, 31), null);
    assert.equal(loggableInt('3', 1, 31), null);
    assert.equal(loggableInt(undefined, 1, 31), null);
  });
});
