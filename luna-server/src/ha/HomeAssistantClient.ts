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
 * Espera antes da leitura de estado que confirma um `callService` em
 * background. Dispositivos reais (ESPHome via WiFi, Zigbee2mqtt, integrações
 * na nuvem) levam um round-trip para propagar o novo estado ao HA — uma
 * leitura imediata corre contra esse atraso e declara falha num comando que,
 * na verdade, funcionou. A verificação fica fora do caminho crítico (o
 * functionResponse ao modelo não espera por ela), então a folga pode ser
 * generosa.
 */
const STATE_VERIFY_DELAY_MS = 1500;

/**
 * Domínios que a Luna pode acionar. Sem essa allowlist, `automation.*`,
 * `update.*` e sensores entrariam no vocabulário da IA junto com as luzes.
 */
const ACTIONABLE_DOMAINS = ['switch', 'light', 'fan'];

/**
 * Renderiza no HA o mapa (área, entidade) que o registro de dispositivos
 * precisa. A REST API não expõe o registro de áreas diretamente — só a API
 * WebSocket — mas `/api/template` roda Jinja com `areas()`/`area_entities()`,
 * o que resolve tudo em uma chamada.
 *
 * `namespace` + `tojson` em vez de montar JSON por concatenação: uma área sem
 * entidades deixaria vírgula sobrando e quebraria o parse.
 */
const AREA_ENTITIES_TEMPLATE = `
{%- set ns = namespace(rows=[]) -%}
{%- for a in areas() -%}
  {%- for e in area_entities(a) -%}
    {%- if e.split('.')[0] in ${JSON.stringify(ACTIONABLE_DOMAINS)} -%}
      {%- set ns.rows = ns.rows + [{'device': e.split('.')[1], 'room_id': a,
          'entity_id': e, 'name': state_attr(e, 'friendly_name')}] -%}
    {%- endif -%}
  {%- endfor -%}
{%- endfor -%}
{{ ns.rows | tojson }}
`;

/** Uma entidade acionável descoberta no HA. */
export interface DiscoveredEntity {
  device: string;
  room_id: string;
  entity_id: string;
  name?: string;
}

function isDiscoveredEntity(row: unknown): row is DiscoveredEntity {
  if (typeof row !== 'object' || row === null) return false;
  const { device, room_id: roomId, entity_id: entityId } = row as Record<string, unknown>;
  return (
    typeof device === 'string' &&
    device.length > 0 &&
    typeof roomId === 'string' &&
    roomId.length > 0 &&
    typeof entityId === 'string' &&
    entityId.includes('.')
  );
}

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
    private readonly sleepImpl: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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

      // `res.ok` não prova que algo foi acionado: o HA aceita `POST
      // /api/services/<domain>/<service>` com 200 mesmo quando `entity_id` não
      // corresponde a nenhuma entidade real — não valida o alvo, só devolve
      // (neste corpo) a lista de entidades que de fato mudaram de estado. Um
      // `entity_id` desatualizado (registro com TTL de 5min, entidade renomeada
      // ou removida no HA nesse meio-tempo) cai exatamente aqui: 200, êxito
      // relatado, nada acionado. A lista, quando confirma, poupa a verificação
      // em background.
      const body: unknown = await res.json().catch(() => null);
      const changed = Array.isArray(body) ? (body as Array<{ entity_id?: unknown }>) : [];
      const confirmedByBody = changed.some((row) => row?.entity_id === entityId);

      if (confirmedByBody) {
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
      }

      // Lista vazia é ambígua por natureza da API: tanto "já estava nesse
      // estado" (no-op legítimo) quanto "entidade não existe" (o footgun acima)
      // voltam como `200 []`. Esperar o estado propagar para desambiguar
      // custava o tempo de propagação do dispositivo (>1s num ESPHome via
      // WiFi) dentro da resposta falada — e ainda errava, porque a propagação
      // pode passar de qualquer espera razoável. Então o 200 vale como
      // sucesso, e a desambiguação roda em background só para telemetria.
      getLogger().info(
        {
          event: 'ha_call_service',
          domain,
          service,
          entity_id: entityId,
          status: res.status,
          latency_ms: latencyMs,
          confirmed_by_body: false,
        },
        `Home Assistant aceitou ${domain}.${service} em ${entityId} (sem confirmação no corpo)`,
      );
      // `getState` já captura tudo, então isto é seguro hoje — mas fica a um
      // refactor de virar unhandledRejection. `.catch` explícito: telemetria
      // não pode ter caminho nenhum de derrubar o processo.
      this.verifyStateEventually(domain, service, entityId).catch((err) => {
        getLogger().warn(
          { event: 'ha_verify', entity_id: entityId, err: this.describeFailure(err) },
          `Falha inesperada na verificação em background de ${entityId}`,
        );
      });
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
   * Desambigua em background o `200 []` de `callService`: espera o estado
   * propagar e faz uma única leitura. Só telemetria — o turno já foi
   * respondido. É aqui que o footgun do `entity_id` obsoleto (200, êxito
   * relatado, nada acionado) fica visível: `confirmed: false` recorrente numa
   * entidade indica registro desatualizado, não dispositivo lento.
   */
  private async verifyStateEventually(
    domain: string,
    service: string,
    entityId: string,
  ): Promise<void> {
    const expectedState =
      service === 'turn_on' ? 'on' : service === 'turn_off' ? 'off' : null;
    if (expectedState === null) {
      return;
    }

    const startedAt = Date.now();
    await this.sleepImpl(STATE_VERIFY_DELAY_MS);
    const actualState = await this.getState(entityId);
    const confirmed = actualState === expectedState;

    getLogger()[confirmed ? 'info' : 'warn'](
      {
        event: 'ha_verify',
        domain,
        service,
        entity_id: entityId,
        confirmed,
        actual_state: actualState,
        elapsed_ms: Date.now() - startedAt,
      },
      confirmed
        ? `Verificação: ${entityId} chegou a "${expectedState}"`
        : `Verificação: ${entityId} não chegou a "${expectedState}" ` +
          `(atual: ${actualState ?? 'desconhecido'}) — dispositivo lento ou entity_id obsoleto`,
    );
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

  /**
   * Lista as entidades acionáveis agrupadas por área do HA, ou `null` se não
   * foi possível descobrir. O HA é a fonte de verdade: dispositivo novo
   * cadastrado lá e atribuído a uma área aparece aqui sem tocar em código.
   */
  async listAreaEntities(): Promise<DiscoveredEntity[] | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const url = `${this.baseUrl()}/api/template`;
    const startedAt = Date.now();

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.haToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ template: AREA_ENTITIES_TEMPLATE }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        getLogger().warn(
          { event: 'ha_list_entities', status: res.status, latency_ms: latencyMs },
          `Home Assistant respondeu ${res.status} ao renderizar o template de áreas`,
        );
        return null;
      }

      // `/api/template` devolve o texto renderizado, não JSON estruturado.
      const entities = this.parseDiscovered(await res.text());
      if (entities === null) return null;

      getLogger().info(
        { event: 'ha_list_entities', count: entities.length, latency_ms: latencyMs },
        `Home Assistant: ${entities.length} entidades acionáveis descobertas`,
      );
      return entities;
    } catch (err) {
      getLogger().warn(
        {
          event: 'ha_list_entities',
          latency_ms: Date.now() - startedAt,
          err: this.describeFailure(err),
        },
        'Falha ao descobrir entidades no Home Assistant',
      );
      return null;
    }
  }

  /**
   * Entrada malformada é descartada individualmente: uma entidade estranha não
   * pode zerar o vocabulário inteiro da Luna. Já um corpo que nem é lista é
   * falha de verdade — devolve `null` e o chamador mantém o snapshot anterior.
   */
  private parseDiscovered(body: string): DiscoveredEntity[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      getLogger().warn(
        { event: 'ha_list_entities', body: body.slice(0, 200) },
        'Template de áreas não devolveu JSON',
      );
      return null;
    }

    if (!Array.isArray(parsed)) {
      getLogger().warn(
        { event: 'ha_list_entities' },
        'Template de áreas não devolveu uma lista',
      );
      return null;
    }

    const entities: DiscoveredEntity[] = [];
    for (const row of parsed) {
      if (!isDiscoveredEntity(row)) {
        getLogger().warn(
          { event: 'ha_list_entities', row },
          'Entidade descoberta com forma inesperada: descartada',
        );
        continue;
      }
      entities.push(row);
    }
    return entities;
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
