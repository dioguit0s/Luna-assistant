import type { AppConfig } from '../config/env.js';
import { getLogger } from '../logging/logger.js';

/**
 * Resultado de uma chamada ao Home Assistant. Mesmo formato que o provider
 * espera em `sendToolResult`, então o Orchestrator repassa direto.
 */
export interface HaServiceResult {
  success: boolean;
  error?: string;
}

/** O áudio é tempo real: não vale a pena esperar mais que isso por um relé. */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Cliente REST do Home Assistant.
 *
 * Nenhum método lança. O HA fora do ar não pode derrubar o turno do usuário —
 * mesma convenção de `GeminiLiveAdapter.sendToolResult`: loga e degrada.
 */
export class HomeAssistantClient {
  private configWarningLogged = false;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Aciona um serviço, ex: `callService('switch', 'turn_on', 'switch.luz_bancada')`.
   */
  async callService(
    domain: string,
    service: string,
    entityId: string,
  ): Promise<HaServiceResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Home Assistant não configurado' };
    }

    const url = `${this.baseUrl()}/api/services/${domain}/${service}`;
    const startedAt = Date.now();

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.haToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: entityId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        getLogger().error(
          {
            event: 'ha_call_service',
            domain,
            service,
            entity_id: entityId,
            status: res.status,
            latency_ms: latencyMs,
          },
          `Home Assistant respondeu ${res.status} em ${domain}.${service}`,
        );
        return { success: false, error: `Home Assistant respondeu ${res.status}` };
      }

      getLogger().info(
        {
          event: 'ha_call_service',
          domain,
          service,
          entity_id: entityId,
          status: res.status,
          latency_ms: latencyMs,
        },
        `Home Assistant: ${domain}.${service} em ${entityId}`,
      );
      return { success: true };
    } catch (err) {
      const error = this.describeFailure(err);
      getLogger().error(
        {
          event: 'ha_call_service',
          domain,
          service,
          entity_id: entityId,
          latency_ms: Date.now() - startedAt,
          err: error,
        },
        `Falha ao chamar ${domain}.${service} no Home Assistant`,
      );
      return { success: false, error };
    }
  }

  /**
   * Estado atual de uma entidade (ex: `'on'` / `'off'`), ou `null` se não foi
   * possível obter — o chamador não distingue os motivos, só sabe que não sabe.
   */
  async getState(entityId: string): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const url = `${this.baseUrl()}/api/states/${entityId}`;
    const startedAt = Date.now();

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.haToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        getLogger().warn(
          {
            event: 'ha_get_state',
            entity_id: entityId,
            status: res.status,
            latency_ms: latencyMs,
          },
          `Home Assistant respondeu ${res.status} ao ler ${entityId}`,
        );
        return null;
      }

      const body = (await res.json()) as { state?: unknown };
      if (typeof body.state !== 'string') {
        getLogger().warn(
          { event: 'ha_get_state', entity_id: entityId, latency_ms: latencyMs },
          `Resposta sem campo "state" para ${entityId}`,
        );
        return null;
      }

      getLogger().info(
        {
          event: 'ha_get_state',
          entity_id: entityId,
          state: body.state,
          latency_ms: latencyMs,
        },
        `Estado de ${entityId}: ${body.state}`,
      );
      return body.state;
    } catch (err) {
      getLogger().warn(
        {
          event: 'ha_get_state',
          entity_id: entityId,
          latency_ms: Date.now() - startedAt,
          err: this.describeFailure(err),
        },
        `Falha ao ler estado de ${entityId}`,
      );
      return null;
    }
  }

  /** `haUrl`/`haToken` têm default vazio no env; sem eles não há o que chamar. */
  private isConfigured(): boolean {
    if (this.config.haUrl && this.config.haToken) return true;

    if (!this.configWarningLogged) {
      this.configWarningLogged = true;
      getLogger().warn(
        { event: 'ha_not_configured' },
        'HA_URL/HA_TOKEN ausentes: comandos de automação serão ignorados',
      );
    }
    return false;
  }

  private baseUrl(): string {
    return this.config.haUrl.replace(/\/+$/, '');
  }

  private describeFailure(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return `timeout após ${this.timeoutMs}ms`;
      }
      return err.message;
    }
    return 'erro desconhecido';
  }
}
