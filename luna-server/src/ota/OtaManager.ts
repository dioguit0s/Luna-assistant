import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger } from '../logging/logger.js';
import { normalizeRemoteAddress } from '../ws/deviceInfo.js';
import {
  FirmwareIntegrityError,
  SEMVER_PATTERN,
  type FirmwareRelease,
} from './firmwareReleases.js';

/**
 * Atualização de firmware pela rede, um satélite por vez (ADR 012).
 *
 * ```
 * downloading ──► sending ──► rebooting ──► ok
 *      │             │            ├──────► rolled_back  (voltou noutra versão)
 *      └─────────────┴────────────┴──────► failed
 * ```
 *
 * - `downloading`: o servidor baixa o `.bin` da release no GitHub e confere o
 *   SHA-256 contra o manifest. Não conferiu = `failed`, nada chega ao satélite.
 * - `sending`: `ota_start` enviado com uma URL de uso único na LAN; o satélite
 *   baixa daqui e reporta `ota_progress`. Termina no `ota_result`.
 * - `rebooting`: `ota_result { ok: true }`; o satélite reinicia na imagem nova.
 *   A confirmação é o `device_info` da conexão seguinte: versão (e build) do
 *   alvo = `ok`; qualquer outra = `rolled_back` (o bootloader voltou para a
 *   anterior porque a nova não autenticou ou entrou em boot loop).
 *
 * Estado em memória: um restart do servidor no meio esquece o acompanhamento,
 * não o satélite — ele termina sozinho e aparece com a versão que ficou.
 */

export type OtaState = 'downloading' | 'sending' | 'rebooting' | 'ok' | 'failed' | 'rolled_back';

const ACTIVE_STATES: ReadonlySet<OtaState> = new Set(['downloading', 'sending', 'rebooting']);

/** O que o painel vê (`GET /admin/v1/satellites/:id/ota` e a lista de satélites). */
export interface OtaJobView {
  state: OtaState;
  target_version: string;
  from_version: string | null;
  percent: number;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

/** O que a OTA precisa saber da conexão do satélite — ver `WsServer.otaConnection`. */
export interface OtaConnection {
  /** Endereço local do socket: o IP do servidor como o satélite o enxerga. */
  localAddress: string | null;
  /** Porta HTTP/WS do servidor. */
  port: number | null;
  /** Endereço do satélite — só ele pode baixar a imagem. */
  remoteAddress: string | null;
  fwVersion: string | null;
  fwBuild: string | null;
}

export interface OtaLink {
  /** Conexão autenticada mais recente do `device_id`, ou `null` offline. */
  connection(deviceId: string): OtaConnection | null;
  /** Manda `ota_start` à conexão mais recente; `false` se não saiu. */
  sendOtaStart(deviceId: string, payload: { url: string; version: string; sha256: string; size: number }): boolean;
}

export interface ReleaseSource {
  find(version: string): Promise<FirmwareRelease | null>;
  download(release: FirmwareRelease): Promise<Buffer>;
}

export interface OtaTimeouts {
  /** `ota_start` sem nenhum `ota_progress`/`ota_result`: firmware anterior à OTA. */
  firstResponseMs: number;
  /** Envio sem `ota_progress` novo. */
  progressStallMs: number;
  /**
   * `ota_result ok` sem o satélite voltar. Acima da janela de validação do
   * firmware (`OTA_VALIDATE_TIMEOUT_MS`, 5 min) mais o boot: a imagem nova que
   * não autentica é revertida e o satélite volta na anterior antes disto.
   */
  rebootMs: number;
  /** Validade da URL de uso único. */
  tokenTtlMs: number;
}

export const DEFAULT_OTA_TIMEOUTS: OtaTimeouts = {
  firstResponseMs: 15_000,
  progressStallMs: 60_000,
  rebootMs: 7 * 60_000,
  tokenTtlMs: 10 * 60_000,
};

/** Recusa do pedido, já com o status HTTP que a API admin devolve. */
export class OtaRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Job {
  deviceId: string;
  targetVersion: string;
  targetBuild: string | null;
  fromVersion: string | null;
  state: OtaState;
  percent: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** Falhou por prazo (sem resposta/progresso/volta), não por recusa ou integridade. */
  timedOut: boolean;
  /** Quando o `ota_start` saiu. */
  sentAt: number | null;
  /** Quando o satélite confirmou a gravação (`ota_result ok`). */
  resultAt: number | null;
  timer: NodeJS.Timeout | null;
  token: string | null;
}

interface ServedImage {
  deviceId: string;
  data: Buffer;
  expiresAt: number;
  remoteAddress: string | null;
}

const OTA_PATH = /^\/ota\/([0-9a-f]{32})\.bin$/;

/** Motivo do firmware → frase do painel. */
function explainRefusal(error: string | null): string {
  if (error === 'ocupado') return 'satélite ocupado com uma conversa — tente de novo quando ele voltar ao repouso';
  if (error === 'não suportado') return 'este satélite não suporta atualização pela rede (desktop ou bancada)';
  if (error === 'atualização já em andamento') {
    return 'o satélite ainda está gravando uma atualização anterior — espere ele reiniciar e confira a versão';
  }
  return `satélite recusou: ${error ?? 'sem motivo'}`;
}

export class OtaManager {
  private readonly jobs = new Map<string, Job>();
  private readonly images = new Map<string, ServedImage>();
  private readonly now: () => number;
  private readonly timeouts: OtaTimeouts;

  constructor(
    private readonly deps: {
      releases: ReleaseSource;
      link: OtaLink;
      now?: () => number;
      timeouts?: Partial<OtaTimeouts>;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.timeouts = { ...DEFAULT_OTA_TIMEOUTS, ...deps.timeouts };
  }

  get(deviceId: string): OtaJobView | null {
    const job = this.jobs.get(deviceId);
    return job ? view(job) : null;
  }

  /**
   * Abre uma OTA. Valida na hora o que dá para validar (versão, satélite
   * online, nenhuma OTA em andamento, release existente) e devolve o job em
   * `downloading`; o resto corre em segundo plano e o painel acompanha.
   */
  async start(deviceId: string, version: unknown): Promise<OtaJobView> {
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      throw new OtaRequestError(422, 'version: semver (por exemplo 0.5.0), sem o prefixo fw-v');
    }
    this.assertIdle(deviceId);
    const conn = this.deps.link.connection(deviceId);
    if (!conn) throw new OtaRequestError(409, 'satélite offline — a atualização só começa com ele conectado');

    const release = await this.deps.releases.find(version);
    if (!release) throw new OtaRequestError(404, `versão ${version} não publicada (release fw-v${version} com manifest)`);
    this.assertIdle(deviceId); // outro pedido pode ter entrado durante a busca

    const now = this.now();
    const job: Job = {
      deviceId,
      targetVersion: version,
      targetBuild: release.manifest.build,
      fromVersion: conn.fwVersion,
      state: 'downloading',
      percent: 0,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      timedOut: false,
      sentAt: null,
      resultAt: null,
      timer: null,
      token: null,
    };
    this.jobs.set(deviceId, job);
    getLogger().info(
      { event: 'ota_started', device_id: deviceId, from: conn.fwVersion, to: version },
      `OTA de ${deviceId}: ${conn.fwVersion ?? '?'} → ${version}`,
    );
    void this.run(job, release);
    return view(job);
  }

  private assertIdle(deviceId: string): void {
    const current = this.jobs.get(deviceId);
    if (current && ACTIVE_STATES.has(current.state)) {
      throw new OtaRequestError(409, 'já há uma atualização em andamento neste satélite');
    }
  }

  private async run(job: Job, release: FirmwareRelease): Promise<void> {
    let image: Buffer;
    try {
      image = await this.deps.releases.download(release);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(job, err instanceof FirmwareIntegrityError ? `download recusado: ${message}` : `falha ao baixar do GitHub: ${message}`);
      return;
    }
    if (this.jobs.get(job.deviceId) !== job || job.state !== 'downloading') return;

    const conn = this.deps.link.connection(job.deviceId);
    if (!conn) return this.fail(job, 'satélite ficou offline durante o download');
    if (!conn.localAddress || !conn.port) return this.fail(job, 'endereço do servidor na LAN desconhecido para esta conexão');

    const token = randomBytes(16).toString('hex');
    this.images.set(token, {
      deviceId: job.deviceId,
      data: image,
      expiresAt: this.now() + this.timeouts.tokenTtlMs,
      remoteAddress: conn.remoteAddress,
    });
    job.token = token;
    const host = conn.localAddress.includes(':') ? `[${conn.localAddress}]` : conn.localAddress;
    const url = `http://${host}:${conn.port}/ota/${token}.bin`;

    this.transition(job, 'sending');
    job.sentAt = this.now();
    this.arm(job, this.timeouts.firstResponseMs, () =>
      this.fail(job, 'o satélite não respondeu — firmware anterior à OTA não atualiza pelo painel (grave uma vez por USB)'),
    );
    const sent = this.deps.link.sendOtaStart(job.deviceId, {
      url,
      version: release.version,
      sha256: release.manifest.sha256,
      size: release.manifest.size,
    });
    if (!sent) this.fail(job, 'falha ao enviar ota_start — satélite offline');
  }

  // ─── eventos do satélite (via WsServer) ───────────────────────────────

  handleProgress(deviceId: string, percent: unknown): void {
    const job = this.jobs.get(deviceId);
    if (!job || job.state !== 'sending') return;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      job.percent = Math.max(job.percent, Math.min(100, Math.max(0, Math.round(percent))));
    }
    job.updatedAt = this.now();
    this.arm(job, this.timeouts.progressStallMs, () =>
      this.fail(job, `sem progresso há ${Math.round(this.timeouts.progressStallMs / 1000)} s — Wi-Fi ruim? O satélite segue na versão atual`),
    );
  }

  handleResult(deviceId: string, ok: unknown, error: unknown): void {
    const job = this.jobs.get(deviceId);
    if (!job || job.state !== 'sending') return;
    this.revoke(job);
    if (ok !== true) {
      const reason = typeof error === 'string' ? error.slice(0, 160) : null;
      this.fail(job, explainRefusal(reason));
      return;
    }
    job.percent = 100;
    job.resultAt = this.now();
    this.transition(job, 'rebooting');
    this.arm(job, this.timeouts.rebootMs, () =>
      this.fail(job, `gravado, mas o satélite não voltou em ${Math.round(this.timeouts.rebootMs / 60_000)} min — confira energia e Wi-Fi`),
    );
  }

  /**
   * `device_info` de uma conexão. Só conta de uma conexão aberta depois do
   * marco da fase: a anterior ainda pode estar viva até o reaper derrubá-la
   * (o reinício não manda close frame).
   *
   * - `rebooting`: versão (e build) do alvo = `ok`; outra = `rolled_back`.
   * - `sending`: o download corre numa task do satélite independente do
   *   WebSocket, então uma queda no meio não encerra nada. Se ele voltar já na
   *   versão do alvo, o `ota_result` se perdeu na queda e a imagem pegou: `ok`.
   *   Voltar na versão antiga não diz nada (o download pode estar andando) —
   *   quem decide é o `ota_progress` seguinte ou o prazo sem progresso.
   */
  handleDeviceInfo(deviceId: string, fwVersion: string | null, fwBuild: string | null, connectedAt: number): void {
    const job = this.jobs.get(deviceId);
    if (!job) return;
    const sameBuild = !job.targetBuild || !fwBuild || fwBuild.slice(0, 7) === job.targetBuild;
    const isTarget = fwVersion === job.targetVersion && sameBuild;

    if (job.state === 'sending' && job.sentAt !== null && connectedAt > job.sentAt) {
      if (isTarget) this.finish(job, 'ok', null);
      return;
    }
    // Falha por PRAZO não é prova de nada: a task do satélite não é cancelável
    // e pode ter terminado com o WebSocket fora. Voltou na versão do alvo, numa
    // conexão posterior ao envio, a imagem pegou. Recusa e integridade não
    // passam por aqui — nesses casos nada foi gravado.
    if (job.state === 'failed' && job.timedOut && job.sentAt !== null && connectedAt > job.sentAt) {
      if (isTarget) this.finish(job, 'ok', null);
      return;
    }
    if (job.state !== 'rebooting' || job.resultAt === null || connectedAt < job.resultAt) return;
    if (isTarget) {
      this.finish(job, 'ok', null);
      return;
    }
    this.finish(job, 'rolled_back', `o satélite voltou na versão ${fwVersion ?? 'desconhecida'} — a imagem nova não se validou e foi revertida`);
  }

  // ─── servir a imagem na LAN ───────────────────────────────────────────

  /**
   * `GET /ota/<token>.bin`, fora da API admin: o satélite não tem o token
   * admin. A proteção é o token aleatório de 128 bits, de uso único, com
   * validade curta e preso ao IP do satélite.
   */
  serve = (req: IncomingMessage, res: ServerResponse): boolean => {
    const match = OTA_PATH.exec((req.url ?? '').split('?')[0]!);
    if (!match) return false;
    const token = match[1]!;
    const image = this.images.get(token);
    if (req.method !== 'GET' || !image || image.expiresAt < this.now()) {
      if (image && image.expiresAt < this.now()) this.images.delete(token);
      res.writeHead(404).end();
      return true;
    }
    const from = normalizeRemoteAddress(req.socket.remoteAddress);
    if (image.remoteAddress && from !== image.remoteAddress) {
      getLogger().warn(
        { event: 'ota_image_forbidden', device_id: image.deviceId, remote: from },
        'Imagem de OTA pedida de outro endereço que não o do satélite',
      );
      res.writeHead(403).end();
      return true;
    }
    this.images.delete(token); // uso único: um segundo GET dá 404
    getLogger().info(
      { event: 'ota_image_served', device_id: image.deviceId, bytes: image.data.length },
      `Imagem de OTA entregue a ${image.deviceId} (${image.data.length} bytes)`,
    );
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(image.data.length),
      'cache-control': 'no-store',
    });
    res.end(image.data);
    return true;
  };

  /** Encerra timers e tokens (shutdown do servidor). */
  stop(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
    this.images.clear();
  }

  // ─── internos ─────────────────────────────────────────────────────────

  private transition(job: Job, state: OtaState): void {
    job.state = state;
    job.updatedAt = this.now();
    getLogger().info(
      { event: 'ota_state', device_id: job.deviceId, state, to: job.targetVersion },
      `OTA de ${job.deviceId}: ${state}`,
    );
  }

  private fail(job: Job, error: string): void {
    if (this.jobs.get(job.deviceId) !== job || !ACTIVE_STATES.has(job.state)) return;
    this.finish(job, 'failed', error);
  }

  private finish(job: Job, state: 'ok' | 'failed' | 'rolled_back', error: string | null): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    this.revoke(job);
    job.state = state;
    job.error = error;
    job.updatedAt = this.now();
    job.finishedAt = job.updatedAt;
    const log = getLogger();
    const fields = { event: 'ota_finished', device_id: job.deviceId, state, from: job.fromVersion, to: job.targetVersion, error };
    if (state === 'ok') log.info(fields, `OTA de ${job.deviceId}: atualizado para ${job.targetVersion}`);
    else log.warn(fields, `OTA de ${job.deviceId}: ${state} — ${error}`);
  }

  private revoke(job: Job): void {
    if (job.token) this.images.delete(job.token);
    job.token = null;
  }

  /** Todo prazo armado aqui que vence marca o job como `timedOut` antes do `fail`. */
  private arm(job: Job, ms: number, onTimeout: () => void): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.timer = null;
      job.timedOut = true;
      onTimeout();
    }, ms);
    job.timer.unref?.();
  }
}

function view(job: Job): OtaJobView {
  return {
    state: job.state,
    target_version: job.targetVersion,
    from_version: job.fromVersion,
    percent: job.percent,
    error: job.error,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
  };
}
