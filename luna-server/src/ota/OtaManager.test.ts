import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../logging/logger.js';
import type { AppConfig } from '../config/env.js';
import { FirmwareIntegrityError, type FirmwareRelease } from './firmwareReleases.js';
import { OtaManager, OtaRequestError, type OtaConnection } from './OtaManager.js';

const RELEASE: FirmwareRelease = {
  tag: 'fw-v0.5.0',
  version: '0.5.0',
  publishedAt: null,
  prerelease: false,
  htmlUrl: null,
  binaryUrl: 'https://dl.test/firmware.bin',
  manifest: { version: '0.5.0', build: 'bbbbbbb', commit: null, size: 4, sha256: 'a'.repeat(64), date: null, changelog: '' },
};

interface Sent {
  deviceId: string;
  payload: { url: string; version: string; sha256: string; size: number };
}

function setup(opts: { conn?: OtaConnection | null; download?: () => Promise<Buffer>; timeouts?: Record<string, number> } = {}) {
  let clock = 1_000;
  const sent: Sent[] = [];
  const state = {
    conn: opts.conn === undefined ? ({ localAddress: '192.168.0.10', port: 8080, remoteAddress: '192.168.0.42', fwVersion: '0.4.0', fwBuild: 'aaaaaaa' } as OtaConnection | null) : opts.conn,
  };
  const manager = new OtaManager({
    now: () => clock,
    releases: {
      find: async (v) => (v === RELEASE.version ? RELEASE : null),
      download: opts.download ?? (async () => Buffer.from('IMG!')),
    },
    link: {
      connection: () => state.conn,
      sendOtaStart: (deviceId, payload) => {
        sent.push({ deviceId, payload });
        return true;
      },
    },
    timeouts: { firstResponseMs: 60, progressStallMs: 80, rebootMs: 100, tokenTtlMs: 1_000, ...opts.timeouts },
  });
  return {
    manager,
    sent,
    state,
    tick: (ms: number) => (clock += ms),
    /** Espera o `run()` assíncrono (download) chegar ao envio. */
    flush: () => new Promise((r) => setTimeout(r, 5)),
  };
}

/** Requisição/resposta HTTP mínimas para o `serve`. */
function fakeHttp(url: string, remote: string, method = 'GET') {
  const req = { url, method, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
  const res = new EventEmitter() as unknown as ServerResponse & { status?: number; body?: Buffer; headers?: Record<string, string> };
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    res.status = status;
    res.headers = headers;
    return res;
  }) as never;
  res.end = ((body?: Buffer) => {
    res.body = body;
    return res;
  }) as never;
  return { req, res };
}

describe('OtaManager', () => {
  let ctx: ReturnType<typeof setup>;

  before(() => createLogger({ logLevel: 'silent' } as AppConfig));
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.manager.stop());

  it('pedido válido: downloading, depois sending com ota_start apontando para o IP local da conexão', async () => {
    const job = await ctx.manager.start('sat', '0.5.0');
    assert.equal(job.state, 'downloading');
    assert.equal(job.from_version, '0.4.0');
    await ctx.flush();
    assert.equal(ctx.manager.get('sat')!.state, 'sending');
    assert.equal(ctx.sent.length, 1);
    assert.match(ctx.sent[0]!.payload.url, /^http:\/\/192\.168\.0\.10:8080\/ota\/[0-9a-f]{32}\.bin$/);
    assert.equal(ctx.sent[0]!.payload.sha256, RELEASE.manifest.sha256);
    assert.equal(ctx.sent[0]!.payload.size, RELEASE.manifest.size);
  });

  it('recusas na hora: versão malformada, offline, release inexistente, OTA em andamento', async () => {
    await assert.rejects(ctx.manager.start('sat', 'v0.5'), (e: unknown) => e instanceof OtaRequestError && e.status === 422);
    await assert.rejects(ctx.manager.start('sat', '9.9.9'), (e: unknown) => e instanceof OtaRequestError && e.status === 404);
    await ctx.manager.start('sat', '0.5.0');
    await assert.rejects(ctx.manager.start('sat', '0.5.0'), (e: unknown) => e instanceof OtaRequestError && e.status === 409);

    const offline = setup({ conn: null });
    await assert.rejects(offline.manager.start('sat', '0.5.0'), (e: unknown) => e instanceof OtaRequestError && e.status === 409);
  });

  it('download que não confere com o manifest nunca vira ota_start', async () => {
    const bad = setup({
      download: async () => {
        throw new FirmwareIntegrityError('sha256 diferente do manifest');
      },
    });
    await bad.manager.start('sat', '0.5.0');
    await bad.flush();
    const job = bad.manager.get('sat')!;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /download recusado: sha256 diferente/);
    assert.equal(bad.sent.length, 0);
  });

  it('imagem: só para o IP do satélite, uma vez, e some quando a OTA termina', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    const path = new URL(ctx.sent[0]!.payload.url).pathname;

    const foreign = fakeHttp(path, '::ffff:192.168.0.99');
    assert.equal(ctx.manager.serve(foreign.req, foreign.res), true);
    assert.equal(foreign.res.status, 403);

    const ok = fakeHttp(path, '::ffff:192.168.0.42');
    ctx.manager.serve(ok.req, ok.res);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.res.headers!['content-length'], '4');
    assert.equal(ok.res.body!.toString(), 'IMG!');

    const again = fakeHttp(path, '::ffff:192.168.0.42');
    ctx.manager.serve(again.req, again.res);
    assert.equal(again.res.status, 404);

    const other = fakeHttp('/admin/v1/status', '127.0.0.1');
    assert.equal(ctx.manager.serve(other.req, other.res), false, 'rota alheia não é da OTA');
  });

  it('token vencido é 404', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.tick(2_000);
    const { req, res } = fakeHttp(new URL(ctx.sent[0]!.payload.url).pathname, '192.168.0.42');
    ctx.manager.serve(req, res);
    assert.equal(res.status, 404);
  });

  it('progresso só sobe, rearma o prazo; sem progresso novo, falha', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.manager.handleProgress('sat', 40);
    ctx.manager.handleProgress('sat', 20);
    ctx.manager.handleProgress('sat', 'lixo');
    assert.equal(ctx.manager.get('sat')!.percent, 40);
    await new Promise((r) => setTimeout(r, 50));
    ctx.manager.handleProgress('sat', 60); // rearma: os 80 ms contam daqui
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.manager.get('sat')!.state, 'sending');
    await new Promise((r) => setTimeout(r, 60));
    const job = ctx.manager.get('sat')!;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /sem progresso/);
  });

  it('gravou mas não voltou: falha no prazo de reinício', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.manager.handleResult('sat', true, undefined);
    assert.equal(ctx.manager.get('sat')!.state, 'rebooting');
    await new Promise((r) => setTimeout(r, 130));
    assert.match(ctx.manager.get('sat')!.error!, /não voltou/);
  });

  it('device_info de conexão anterior ao ota_result não decide; da seguinte, sim', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.tick(10);
    ctx.manager.handleResult('sat', true, undefined);
    ctx.manager.handleDeviceInfo('sat', '0.4.0', 'aaaaaaa', 500); // conexão velha, ainda de pé
    assert.equal(ctx.manager.get('sat')!.state, 'rebooting');
    ctx.tick(10);
    ctx.manager.handleDeviceInfo('sat', '0.5.0', 'bbbbbbb', 1_015);
    assert.equal(ctx.manager.get('sat')!.state, 'ok');
  });

  it('mesma versão com build diferente também é reversão', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.manager.handleResult('sat', true, undefined);
    ctx.tick(5);
    ctx.manager.handleDeviceInfo('sat', '0.5.0', 'abcdef0', 2_000);
    assert.equal(ctx.manager.get('sat')!.state, 'rolled_back');
  });

  it('envio: device_info na versão antiga não decide; na do alvo (ota_result perdido na queda) é ok', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.tick(10);
    ctx.manager.handleDeviceInfo('sat', '0.4.0', 'aaaaaaa', 1_020); // reconectou, download ainda andando
    assert.equal(ctx.manager.get('sat')!.state, 'sending');
    ctx.manager.handleDeviceInfo('sat', '0.5.0', 'bbbbbbb', 999); // conexão anterior ao envio: ignora
    assert.equal(ctx.manager.get('sat')!.state, 'sending');
    ctx.manager.handleDeviceInfo('sat', '0.5.0', 'bbbbbbb', 1_030);
    assert.equal(ctx.manager.get('sat')!.state, 'ok');
  });

  it('falha por prazo vira ok se o satélite voltar na versão do alvo; recusa não', async () => {
    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.manager.handleProgress('sat', 30);
    await new Promise((r) => setTimeout(r, 110)); // estoura o prazo sem progresso
    assert.equal(ctx.manager.get('sat')!.state, 'failed');
    ctx.tick(50);
    ctx.manager.handleDeviceInfo('sat', '0.4.0', 'aaaaaaa', 1_040);
    assert.equal(ctx.manager.get('sat')!.state, 'failed', 'versão antiga não muda nada');
    ctx.manager.handleDeviceInfo('sat', '0.5.0', 'bbbbbbb', 1_045);
    assert.equal(ctx.manager.get('sat')!.state, 'ok');

    const refused = setup();
    await refused.manager.start('sat', '0.5.0');
    await refused.flush();
    refused.manager.handleResult('sat', false, 'atualização já em andamento');
    assert.match(refused.manager.get('sat')!.error!, /gravando uma atualização anterior/);
    refused.tick(50);
    refused.manager.handleDeviceInfo('sat', '0.5.0', 'bbbbbbb', 2_000);
    assert.equal(refused.manager.get('sat')!.state, 'failed', 'recusa não ressuscita');
  });

  it('eventos fora de hora (sem OTA, ou já terminada) são ignorados', async () => {
    ctx.manager.handleProgress('ninguem', 50);
    ctx.manager.handleResult('ninguem', true, undefined);
    ctx.manager.handleDeviceInfo('ninguem', '0.5.0', null, 0);
    assert.equal(ctx.manager.get('ninguem'), null);

    await ctx.manager.start('sat', '0.5.0');
    await ctx.flush();
    ctx.manager.handleResult('sat', false, 'ocupado');
    ctx.manager.handleResult('sat', true, undefined);
    assert.equal(ctx.manager.get('sat')!.state, 'failed');
  });
});
