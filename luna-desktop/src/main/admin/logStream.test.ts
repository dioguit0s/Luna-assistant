import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LogStream, type LogStreamEvent } from './logStream.js';

const CONN = { serverUrl: 'ws://192.168.0.20:8080', adminToken: 'tok' };

/** Resposta SSE cujo corpo o teste alimenta à mão. */
function sseResponse(): { response: Response; push(text: string): void; end(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const line = (seq: number, ts: number, msg: string): string =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, ts, msg })}\n\n`;

describe('LogStream', () => {
  it('conecta com token e filtro, entrega linhas e ignora comentários', async () => {
    const urls: string[] = [];
    const auth: string[] = [];
    const sse = sseResponse();
    const events: LogStreamEvent[] = [];
    const stream = new LogStream(() => CONN, (e) => events.push(e), (async (url: string, init: RequestInit) => {
      urls.push(url);
      auth.push((init.headers as Record<string, string>).authorization!);
      return sse.response;
    }) as unknown as typeof fetch);

    stream.start({ level: 'warn', room: 'quarto' });
    await tick();
    // Bloco partido entre dois pedaços do stream ainda vira uma linha só.
    sse.push(': ok\n\n' + line(1, 100, 'um').slice(0, 10));
    sse.push(line(1, 100, 'um').slice(10));
    await tick();
    stream.stop();

    assert.equal(urls[0], 'http://192.168.0.20:8080/admin/v1/logs/stream?level=warn&room=quarto');
    assert.equal(auth[0], 'Bearer tok');
    const logs = events.filter((e) => e.type === 'log');
    assert.equal(logs.length, 1);
    assert.deepEqual((logs[0] as { record: unknown }).record, { seq: 1, ts: 100, msg: 'um' });
    assert.ok(events.some((e) => e.type === 'log-status' && e.state === 'open'));
  });

  it('reconexão não repete o passado já entregue, mas aceita servidor reiniciado', async () => {
    const streams = [sseResponse(), sseResponse()];
    let n = 0;
    const events: LogStreamEvent[] = [];
    const stream = new LogStream(() => CONN, (e) => events.push(e), (async () => streams[n++]!.response) as unknown as typeof fetch);

    stream.start({ level: 'info', room: null });
    await tick();
    streams[0]!.push(line(5, 500, 'a') + line(6, 600, 'b'));
    await tick();
    streams[0]!.end();
    // Espera o primeiro backoff (1s) e a segunda conexão.
    await new Promise((r) => setTimeout(r, 1100));
    // Processo novo: seq recomeça, com o passado velho reenviado antes.
    streams[1]!.push(line(6, 600, 'b') + line(1, 700, 'c'));
    await tick();
    stream.stop();

    const msgs = events.filter((e) => e.type === 'log').map((e) => (e as { record: { msg: string } }).record.msg);
    assert.deepEqual(msgs, ['a', 'b', 'c']);
  });

  it('sem nem o ping do servidor, derruba e reconecta', async () => {
    const streams = [sseResponse(), sseResponse()];
    let n = 0;
    const events: LogStreamEvent[] = [];
    const stream = new LogStream(() => CONN, (e) => events.push(e), (async (_url: string, init: RequestInit) => {
      const s = streams[n++]!;
      init.signal?.addEventListener('abort', () => s.end());
      return s.response;
    }) as unknown as typeof fetch, 50);
    stream.start({ level: 'info', room: null });
    await new Promise((r) => setTimeout(r, 1200));
    stream.stop(false);
    assert.equal(n, 2, 'não reconectou depois do silêncio');
  });

  it('401 não fica tentando: fecha com o erro', async () => {
    let calls = 0;
    const events: LogStreamEvent[] = [];
    const stream = new LogStream(() => CONN, (e) => events.push(e), (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'token inválido' }), { status: 401 });
    }) as unknown as typeof fetch);
    stream.start({ level: 'info', room: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 1);
    const last = events[events.length - 1]!;
    assert.deepEqual(last, { type: 'log-status', state: 'closed', error: 'token inválido' });
    stream.stop(false);
  });

  it('sem token nem tenta', () => {
    const events: LogStreamEvent[] = [];
    const stream = new LogStream(() => ({ ...CONN, adminToken: '' }), (e) => events.push(e), (() => {
      throw new Error('não deveria chamar');
    }) as unknown as typeof fetch);
    stream.start({ level: 'info', room: null });
    assert.equal(events[0]!.type, 'log-status');
  });
});
