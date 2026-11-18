import { createHash } from 'node:crypto';
import { getLogger } from '../logging/logger.js';

/**
 * Releases de firmware publicadas no GitHub pelo workflow `firmware-release.yml`
 * (tag `fw-vX.Y.Z` → release com `firmware.bin` + `manifest.json`). Ver ADR 012.
 *
 * O servidor é o único lado que fala com a internet: o satélite nunca vê o
 * GitHub nem o TLS dele — baixa o `.bin` do próprio servidor, na LAN.
 */

/** `manifest.json` de uma release, como o CI grava (ver `luna-firmware/tools/fw_manifest.py`). */
export interface FirmwareManifest {
  version: string;
  /** SHA curto (7) do commit da tag — o mesmo `FW_BUILD` embutido no binário. */
  build: string;
  /** SHA completo do commit, quando presente. */
  commit: string | null;
  size: number;
  sha256: string;
  /** ISO 8601 do build. */
  date: string | null;
  changelog: string;
}

export interface FirmwareRelease {
  tag: string;
  version: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** Página da release no GitHub. */
  htmlUrl: string | null;
  /** URL do asset `firmware.bin`. */
  binaryUrl: string;
  manifest: FirmwareManifest;
}

export interface ReleaseList {
  releases: FirmwareRelease[];
  /** Quando a lista foi buscada no GitHub (relógio do servidor). */
  fetchedAt: number;
  /** Última busca falhou e a lista é a anterior (ou vazia). */
  stale: boolean;
  error: string | null;
}

/** Teto da imagem: partições `app0`/`app1` de 6,5 MB (`default_16MB.csv`). */
export const MAX_FIRMWARE_BYTES = 0x680000;
/** Cache da lista: o painel pede a cada repaint; a API sem token dá 60/h. */
export const RELEASES_TTL_MS = 5 * 60_000;
/**
 * Depois de uma falha, quanto tempo devolver a resposta de falha sem tentar de
 * novo. Sem isto, o painel (que pede a cada repaint, 1,5 s durante uma OTA)
 * mandaria um GET novo a cada vez — com até 10 s de espera cada um e, no 403 de
 * limite esgotado, gastando ainda mais cota.
 */
export const RELEASES_FAILURE_TTL_MS = 60_000;
/** Releases olhadas por busca (cada uma custa um GET do `manifest.json`). */
const MAX_RELEASES = 15;
const REQUEST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export const TAG_PREFIX = 'fw-v';
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_PATTERN = /^[0-9a-f]{7,40}$/;

/** Download que não confere com o manifest — nunca chega ao satélite. */
export class FirmwareIntegrityError extends Error {}

export interface FirmwareReleasesOptions {
  /** `dono/repositorio`. */
  repo: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Ver `RELEASES_FAILURE_TTL_MS`. */
  failureTtlMs?: number;
  /** Opcional: só para subir o limite de requisições da API do GitHub. */
  token?: string;
}

/** Compara semver `a` e `b` (pré-release vem antes da final). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...pre] = v.split('-');
    return { nums: (core ?? '').split('.').map((n) => Number(n) || 0), pre: pre.length ? pre.join('-') : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/**
 * Valida o `manifest.json` vindo da internet. Defensivo: qualquer campo fora
 * do formato descarta a release inteira — é com o `sha256` e o `size` daqui
 * que o servidor e o satélite decidem se a imagem é a certa.
 */
export function parseManifest(raw: unknown): FirmwareManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const version = typeof m.version === 'string' ? m.version : '';
  const build = typeof m.build === 'string' ? m.build.toLowerCase() : '';
  const sha256 = typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : '';
  const size = m.size;
  if (!SEMVER_PATTERN.test(version) || !BUILD_PATTERN.test(build) || !SHA256_PATTERN.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_FIRMWARE_BYTES) return null;
  const commit = typeof m.commit === 'string' && BUILD_PATTERN.test(m.commit.toLowerCase()) ? m.commit.toLowerCase() : null;
  const date = typeof m.date === 'string' && m.date.length <= 40 ? m.date : null;
  const changelog = typeof m.changelog === 'string' ? m.changelog.slice(0, 2000) : '';
  return { version, build: build.slice(0, 7), commit, size, sha256, date, changelog };
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

export class FirmwareReleases {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cache: ReleaseList | null = null;
  /** Última falha e quando — ver `RELEASES_FAILURE_TTL_MS`. */
  private lastFailure: { at: number; result: ReleaseList } | null = null;
  private inflight: Promise<ReleaseList> | null = null;
  /** Último binário baixado e conferido, por versão — retentar depois de "ocupado" não baixa de novo. */
  private readonly binaries = new Map<string, Buffer>();

  constructor(private readonly opts: FirmwareReleasesOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? RELEASES_TTL_MS;
    this.failureTtlMs = opts.failureTtlMs ?? RELEASES_FAILURE_TTL_MS;
  }

  get repo(): string {
    return this.opts.repo;
  }

  /**
   * Releases `fw-v*` com manifest válido, da mais nova para a mais velha.
   * Cache de `ttlMs`; com o GitHub fora, devolve a última lista boa marcada
   * `stale` (ou vazia, com `error`). Nunca lança.
   */
  async list(force = false): Promise<ReleaseList> {
    if (!force && this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) return this.cache;
    if (!force && this.lastFailure && this.now() - this.lastFailure.at < this.failureTtlMs) return this.lastFailure.result;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchList()
      .then((releases) => {
        this.cache = { releases, fetchedAt: this.now(), stale: false, error: null };
        this.lastFailure = null;
        return this.cache;
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        getLogger().warn({ event: 'firmware_releases_failed', repo: this.opts.repo, err: error }, 'Falha ao listar releases de firmware no GitHub');
        // Não renova o `fetchedAt` da lista boa; quem segura as novas tentativas
        // é o `lastFailure`, por `failureTtlMs`.
        const result: ReleaseList = this.cache
          ? { ...this.cache, stale: true, error }
          : { releases: [], fetchedAt: this.now(), stale: true, error };
        this.lastFailure = { at: this.now(), result };
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async find(version: string): Promise<FirmwareRelease | null> {
    const hit = (list: ReleaseList): FirmwareRelease | null => list.releases.find((r) => r.version === version) ?? null;
    const cached = await this.list();
    // Release recém-publicada ainda fora do cache: uma busca forçada antes de dizer que não existe.
    return hit(cached) ?? (cached.stale ? null : hit(await this.list(true)));
  }

  /**
   * Baixa o `.bin` da release e confere tamanho e SHA-256 contra o manifest.
   * Lança `FirmwareIntegrityError` se não conferir — o binário nunca é servido.
   */
  async download(release: FirmwareRelease): Promise<Buffer> {
    const cached = this.binaries.get(release.version);
    if (cached && sha256(cached) === release.manifest.sha256) return cached;

    const res = await this.fetchImpl(release.binaryUrl, {
      headers: this.headers('application/octet-stream'),
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`download do firmware.bin: HTTP ${res.status}`);
    const expected = release.manifest.size;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && declared !== expected) {
      throw new FirmwareIntegrityError(`tamanho diferente do manifest (${declared} ≠ ${expected} bytes)`);
    }
    const body = await readCapped(res, expected);
    if (body.length !== expected) {
      throw new FirmwareIntegrityError(`tamanho diferente do manifest (${body.length} ≠ ${expected} bytes)`);
    }
    const digest = sha256(body);
    if (digest !== release.manifest.sha256) {
      throw new FirmwareIntegrityError(`sha256 diferente do manifest (${digest.slice(0, 12)}… ≠ ${release.manifest.sha256.slice(0, 12)}…)`);
    }
    this.binaries.clear(); // um só na memória: até 6,5 MB cada
    this.binaries.set(release.version, body);
    return body;
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      // Nome genérico: a API do GitHub exige User-Agent, e nada do usuário vai nele.
      'user-agent': 'luna-server',
      ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
    };
  }

  private async fetchJson(url: string, accept = 'application/vnd.github+json'): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      headers: this.headers(accept),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const limited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(limited ? 'limite de requisições da API do GitHub esgotado — tente em alguns minutos' : `GitHub respondeu HTTP ${res.status}`);
    }
    return res.json();
  }

  private async fetchList(): Promise<FirmwareRelease[]> {
    const raw = await this.fetchJson(`https://api.github.com/repos/${this.opts.repo}/releases?per_page=50`);
    if (!Array.isArray(raw)) throw new Error('resposta inesperada da API do GitHub');

    const candidates = (raw as GithubRelease[])
      .filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith(TAG_PREFIX) && r.draft !== true)
      .slice(0, MAX_RELEASES);

    const resolved = await Promise.all(
      candidates.map(async (r): Promise<FirmwareRelease | null> => {
        const tag = r.tag_name as string;
        const version = tag.slice(TAG_PREFIX.length);
        const assets = Array.isArray(r.assets) ? (r.assets as GithubAsset[]) : [];
        const url = (name: string): string | null => {
          const a = assets.find((x) => x.name === name);
          return a && typeof a.browser_download_url === 'string' ? a.browser_download_url : null;
        };
        const binaryUrl = url('firmware.bin');
        const manifestUrl = url('manifest.json');
        if (!SEMVER_PATTERN.test(version) || !binaryUrl || !manifestUrl) return null;
        let manifest: FirmwareManifest | null = null;
        try {
          manifest = parseManifest(await this.fetchJson(manifestUrl, 'application/json'));
        } catch (err) {
          getLogger().warn({ event: 'firmware_manifest_failed', tag, err: err instanceof Error ? err.message : String(err) }, `Manifest da release ${tag} inacessível`);
          return null;
        }
        if (!manifest || manifest.version !== version) {
          getLogger().warn({ event: 'firmware_manifest_invalid', tag }, `Release ${tag} ignorada: manifest inválido ou de outra versão`);
          return null;
        }
        return {
          tag,
          version,
          publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
          prerelease: r.prerelease === true,
          htmlUrl: typeof r.html_url === 'string' ? r.html_url : null,
          binaryUrl,
          manifest,
        };
      }),
    );
    return resolved.filter((r): r is FirmwareRelease => r !== null).sort((a, b) => compareVersions(b.version, a.version));
  }
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lê o corpo sem passar de `limit` bytes (+1 para detectar excesso). */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new FirmwareIntegrityError(`maior que o manifest (> ${limit} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
