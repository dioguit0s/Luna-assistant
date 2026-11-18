import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLogger } from '../logging/logger.js';
import type { AppConfig } from '../config/env.js';
import { FirmwareIntegrityError, FirmwareReleases, compareVersions, parseManifest } from './firmwareReleases.js';

const BIN = Buffer.from('imagem de firmware');
const SHA = createHash('sha256').update(BIN).digest('hex');

function manifest(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version, build: '1234567', size: BIN.length, sha256: SHA, date: '2026-11-17T00:00:00Z', changelog: 'x', ...extra };
}

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-11-17T00:00:00Z',
    html_url: `https://github.com/x/y/releases/tag/${tag}`,
    assets: [
      { name: 'firmware.bin', browser_download_url: `https://dl.test/${tag}/firmware.bin` },
      { name: 'manifest.json', browser_download_url: `https://dl.test/${tag}/manifest.json` },
    ],
    ...extra,
  };
}

function fakeFetch(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response('nada', { status: 404 });
  }) as unknown as typeof fetch;
}

const LIST_URL = 'https://api.github.com/repos/x/y/releases?per_page=50';

describe('FirmwareReleases', () => {
  before(() => createLogger({ logLevel: 'silent' } as AppConfig));

  it('só tags fw-v com manifest válido e da mesma versão, da mais nova para a mais velha', async () => {
    const fetchImpl = fakeFetch({
      [LIST_URL]: () =>
        Response.json([
          release('fw-v0.4.0'),
          release('v1.0.0'), // release do servidor/app, não de firmware
          release('fw-v0.10.0'),
          release('fw-v0.6.0', { draft: true }),
          release('fw-v0.7.0'), // manifest de outra versão
          release('fw-v0.8.0'), // manifest inválido
          release('fw-v0.9.0', { assets: [] }),
        ]),
      'https://dl.test/fw-v0.4.0/manifest.json': () => Response.json(manifest('0.4.0')),
      'https://dl.test/fw-v0.10.0/manifest.json': () => Response.json(manifest('0.10.0')),
      'https://dl.test/fw-v0.7.0/manifest.json': () => Response.json(manifest('0.6.9')),
      'https://dl.test/fw-v0.8.0/manifest.json': () => Response.json(manifest('0.8.0', { sha256: 'curto' })),
    });
    const list = await new FirmwareReleases({ repo: 'x/y', fetchImpl }).list();
    assert.equal(list.error, null);
    assert.deepEqual(list.releases.map((r) => r.version), ['0.10.0', '0.4.0']);
    assert.equal(list.releases[0]!.binaryUrl, 'https://dl.test/fw-v0.10.0/firmware.bin');
  });

  it('cache curto: a segunda chamada não vai ao GitHub; forçar vai', async () => {
    const calls: string[] = [];
    let now = 0;
    const fetchImpl = fakeFetch({ [LIST_URL]: () => Response.json([]) }, calls);
    const r = new FirmwareReleases({ repo: 'x/y', fetchImpl, now: () => now, ttlMs: 1_000 });
    await r.list();
    await r.list();
    assert.equal(calls.length, 1);
    now = 2_000;
    await r.list();
    await r.list(true);
    assert.equal(calls.length, 3);
  });

  it('GitHub fora: última lista boa marcada stale; sem lista, vazia com o motivo', async () => {
    let up = true;
    let now = 0;
    const fetchImpl = fakeFetch({
      [LIST_URL]: () => (up ? Response.json([release('fw-v0.4.0')]) : new Response('', { status: 503 })),
      'https://dl.test/fw-v0.4.0/manifest.json': () => Response.json(manifest('0.4.0')),
    });
    const calls: string[] = [];
    const counted = (async (u: string | URL) => {
      calls.push(String(u));
      return fetchImpl(u);
    }) as unknown as typeof fetch;
    const r = new FirmwareReleases({ repo: 'x/y', fetchImpl: counted, now: () => now, ttlMs: 10, failureTtlMs: 1_000 });
    assert.equal((await r.list()).releases.length, 1);
    up = false;
    now = 100;
    const stale = await r.list();
    assert.equal(stale.stale, true);
    assert.match(stale.error!, /503/);
    assert.equal(stale.releases.length, 1);

    // Dentro do prazo de falha, não volta ao GitHub; passado ele, tenta de novo.
    const before = calls.length;
    now = 500;
    assert.equal((await r.list()).stale, true);
    assert.equal(calls.length, before);
    up = true;
    now = 1_200;
    assert.equal((await r.list()).stale, false);
    assert.ok(calls.length > before);

    up = false;
    const cold = await new FirmwareReleases({ repo: 'x/y', fetchImpl }).list();
    assert.deepEqual(cold.releases, []);
    assert.match(cold.error!, /503/);
  });

  it('limite da API esgotado vira mensagem explicando', async () => {
    const fetchImpl = fakeFetch({
      [LIST_URL]: () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    assert.match((await new FirmwareReleases({ repo: 'x/y', fetchImpl }).list()).error!, /limite de requisições/);
  });

  it('download confere tamanho e sha256 contra o manifest', async () => {
    const routes: Record<string, () => Response> = {
      [LIST_URL]: () => Response.json([release('fw-v0.4.0')]),
      'https://dl.test/fw-v0.4.0/manifest.json': () => Response.json(manifest('0.4.0')),
      'https://dl.test/fw-v0.4.0/firmware.bin': () => new Response(BIN),
    };
    const r = new FirmwareReleases({ repo: 'x/y', fetchImpl: fakeFetch(routes) });
    const rel = (await r.find('0.4.0'))!;
    assert.deepEqual(await r.download(rel), BIN);

    routes['https://dl.test/fw-v0.4.0/firmware.bin'] = () => new Response(Buffer.from('imagem de firmwarX'));
    const corrupted = new FirmwareReleases({ repo: 'x/y', fetchImpl: fakeFetch(routes) });
    await assert.rejects(corrupted.download(rel), (e: unknown) => e instanceof FirmwareIntegrityError && /sha256 diferente/.test(e.message));

    routes['https://dl.test/fw-v0.4.0/firmware.bin'] = () => new Response(Buffer.concat([BIN, BIN]));
    const bigger = new FirmwareReleases({ repo: 'x/y', fetchImpl: fakeFetch(routes) });
    await assert.rejects(bigger.download(rel), (e: unknown) => e instanceof FirmwareIntegrityError);
  });

  it('find de versão recém-publicada força uma busca antes de dizer que não existe', async () => {
    let published = false;
    const fetchImpl = fakeFetch({
      [LIST_URL]: () => Response.json(published ? [release('fw-v0.5.0')] : []),
      'https://dl.test/fw-v0.5.0/manifest.json': () => Response.json(manifest('0.5.0')),
    });
    const r = new FirmwareReleases({ repo: 'x/y', fetchImpl });
    assert.equal(await r.find('0.5.0'), null);
    published = true;
    assert.equal((await r.find('0.5.0'))?.version, '0.5.0');
  });
});

describe('parseManifest / compareVersions', () => {
  it('recusa manifest com campo fora do formato', () => {
    assert.ok(parseManifest(manifest('0.4.0')));
    assert.equal(parseManifest(manifest('0.4.0', { size: 0x680001 })), null, 'maior que a partição');
    assert.equal(parseManifest(manifest('0.4.0', { size: 1.5 })), null);
    assert.equal(parseManifest(manifest('v0.4.0')), null);
    assert.equal(parseManifest(manifest('0.4.0', { build: 'xyz' })), null);
    assert.equal(parseManifest([]), null);
    assert.equal(parseManifest(manifest('0.4.0', { sha256: SHA.toUpperCase() }))?.sha256, SHA, 'normaliza para minúsculo');
  });

  it('ordena semver numericamente, pré-release antes da final', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
    assert.ok(compareVersions('0.4.9', '0.5.0') < 0);
  });
});
