import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../logging/logger.js';
import { emitLog, resetLogTapForTests, subscribeLogs, type LogRecord } from '../logging/logTap.js';
import { ReminderStore } from '../reminders/ReminderStore.js';
import { DiagnosticsStore, MAX_ROWS, RETENTION_MS } from './DiagnosticsStore.js';
import { Diagnostics, LIVE_BUFFER_SIZE } from './Diagnostics.js';
import type { AppConfig } from '../config/env.js';

createLogger({ logLevel: 'silent' } as AppConfig);

function captured(): LogRecord[] {
  const out: LogRecord[] = [];
  subscribeLogs((r) => out.push(r));
  return out;
}

describe('logTap', () => {
  beforeEach(() => resetLogTapForTests());

  it('leva evento, sala, mensagem e só campos escalares', () => {
    const out = captured();
    emitLog(30, [{ event: 'ttfab', room_id: 'quarto', latency_ms: 420, cold: false, nested: { a: 1 } }, 'TTFAB: 420ms']);
    assert.equal(out.length, 1);
    const [r] = out;
    assert.equal(r!.event, 'ttfab');
    assert.equal(r!.roomId, 'quarto');
    assert.equal(r!.level, 'info');
    assert.equal(r!.msg, 'TTFAB: 420ms');
    assert.deepEqual(r!.fields, { room_id: 'quarto', latency_ms: 420, cold: false });
  });

  it('nunca carrega transcrição: chaves de fala caem fora', () => {
    const out = captured();
    emitLog(30, [{ raw: '{"inputTranscription":"acende a luz"}', transcript: 'x', text: 'y', user_text: 'z', ok: 1 }, 'DEBUG']);
    assert.deepEqual(out[0]!.fields, { ok: 1 });
  });

  it('fala repetida na mensagem some: eventos reais do Orchestrator e do Gemini', () => {
    const out = captured();
    const fala = 'Pronto, marquei o lembrete de tomar o remédio às oito';
    // As duas chamadas exatamente como `Orchestrator` e `GeminiLiveAdapter` fazem.
    emitLog(30, [{ event: 'turn_complete', room_id: 'quarto', had_audio: true, assistant_text: fala }, `Turno concluído: "${fala}"`]);
    emitLog(30, [{ event: 'assistant_transcript_delta', room_id: 'quarto', text: 'tomar o remédio', generation_complete: null }, 'Delta de transcrição da Luna: "tomar o remédio"']);
    // Evento desconhecido que repete um campo de fala no texto.
    emitLog(30, [{ event: 'novo_evento', user_text: 'acende a luz do quarto' }, 'Ouvi "acende a luz do quarto" agora']);
    const all = JSON.stringify(out);
    assert.ok(!all.includes('remédio'), all);
    assert.ok(!all.includes('acende a luz'), all);
    assert.equal(out[0]!.msg, 'Turno concluído');
    assert.equal(out[2]!.msg, 'Ouvi "«fala omitida»" agora');
  });

  it('número com nome parecido com fala continua (não carrega texto)', () => {
    const out = captured();
    emitLog(30, [{ event: 'ttfab', transcript_anchor_moves: 3, context: 'x' }, 'TTFAB']);
    assert.equal(out[0]!.fields.transcript_anchor_moves, 3);
    assert.equal(out[0]!.fields.context, undefined);
  });

  it('aceita (msg) e (err, msg)', () => {
    const out = captured();
    emitLog(40, ['só mensagem']);
    emitLog(50, [new Error('estourou'), 'falhou']);
    assert.equal(out[0]!.msg, 'só mensagem');
    assert.equal(out[1]!.level, 'error');
    assert.equal(out[1]!.fields.err, 'estourou');
  });

  it('ouvinte que lança não derruba os outros', () => {
    subscribeLogs(() => {
      throw new Error('quebrado');
    });
    const out = captured();
    emitLog(30, [{}, 'oi']);
    assert.equal(out.length, 1);
  });
});

describe('Diagnostics', () => {
  function setup(now = () => Date.now()) {
    const store = ReminderStore.open(':memory:');
    const diag = new Diagnostics(new DiagnosticsStore(store.sharedDatabase(), now));
    return { diag, db: store.sharedDatabase() };
  }

  function rec(partial: Partial<LogRecord>): LogRecord {
    return { seq: 0, ts: Date.now(), level: 'info', levelValue: 30, event: null, roomId: null, msg: '', fields: {}, ...partial };
  }

  it('buffer do log ao vivo é circular', () => {
    const { diag } = setup();
    for (let i = 0; i < LIVE_BUFFER_SIZE + 10; i++) diag.ingest(rec({ seq: i, msg: `l${i}` }));
    const recent = diag.recent({ minLevel: 'trace', roomId: null }, LIVE_BUFFER_SIZE * 2);
    assert.equal(recent.length, LIVE_BUFFER_SIZE);
    assert.equal(recent[0]!.msg, 'l10');
  });

  it('com o tap ligado, nada grava dentro da chamada de log', async () => {
    resetLogTapForTests();
    const { diag } = setup();
    diag.start();
    try {
      emitLog(30, [{ event: 'ttfab', room_id: 'quarto', latency_ms: 500, provider: 'gemini' }, 'TTFAB']);
      assert.equal(diag.store.latencySince(0).length, 0, 'gravou no caminho quente');
      await new Promise((r) => setImmediate(r));
      assert.equal(diag.store.latencySince(0).length, 1);
    } finally {
      diag.stop();
    }
  });

  it('ttfab sem sala ou sem latency_ms não vira amostra', () => {
    const { diag } = setup();
    diag.ingest(rec({ event: 'ttfab', fields: { latency_ms: 10 } }));
    diag.ingest(rec({ event: 'ttfab', roomId: 'quarto', fields: {} }));
    assert.equal(diag.store.latencySince(0).length, 0);
  });

  it('poda por idade e por teto de linhas', () => {
    let clock = 10 * RETENTION_MS;
    const { diag, db } = setup(() => clock);
    const store = diag.store;
    store.insertLatency({ at: clock - RETENTION_MS - 1, roomId: 'q', deviceId: null, provider: 'gemini', latencyMs: 1, sinceTurnStartMs: null, providerWaitMs: null, sessionCold: false });
    const insert = db.prepare('INSERT INTO latency_samples (at, room_id, provider, latency_ms) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < MAX_ROWS + 50; i++) insert.run(clock, 'q', 'gemini', i);
    store.prune();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM latency_samples').get() as { n: number }).n;
    const oldest = (db.prepare('SELECT MIN(at) AS at FROM latency_samples').get() as { at: number }).at;
    assert.equal(Number(count), MAX_ROWS);
    assert.equal(Number(oldest), clock, 'a amostra velha saiu');
  });
});
