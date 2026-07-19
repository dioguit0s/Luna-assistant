import { readFileSync } from 'node:fs';
import { getLogger } from '../logging/logger.js';
import type { DiscoveredEntity, HomeAssistantClient } from './HomeAssistantClient.js';
import { DeviceRegistry, toDeviceEntry } from './deviceRegistry.js';
import type { DeviceEntry } from './deviceRegistry.js';

/**
 * Camada de correção sobre a descoberta automática, vinda de `devices.json`.
 * Não é o catálogo — o catálogo é o Home Assistant.
 */
export interface DeviceOverrides {
  /** Apelido falado → `device` real. */
  aliases: Record<string, string>;
  /** `entity_id`s que a IA não pode acionar. */
  exclude: string[];
  /** Entradas manuais, para o que não está em nenhuma área do HA. */
  devices: DeviceEntry[];
}

export const EMPTY_OVERRIDES: DeviceOverrides = {
  aliases: {},
  exclude: [],
  devices: [],
};

/**
 * Lê `devices.json`. Arquivo ausente é o caso normal — a descoberta cobre o uso
 * comum. Arquivo presente e inválido lança: é erro de operador, e subir com o
 * override ignorado esconderia exatamente a correção que alguém quis fazer.
 */
export function loadDeviceOverrides(filePath: string): DeviceOverrides {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    // `info`, não `debug`: ausente é caso válido, mas quando o arquivo *deveria*
    // estar lá (release sem `config/`, path errado) o sintoma aparece longe daqui
    // — como um `unknown_device` para um alias que existe no repositório.
    getLogger().info(
      { event: 'device_overrides_absent', path: filePath, cwd: process.cwd() },
      'Sem devices.json: usando apenas a descoberta do Home Assistant',
    );
    return EMPTY_OVERRIDES;
  }

  return parseDeviceOverrides(raw, filePath);
}

export function parseDeviceOverrides(raw: string, source = 'devices.json'): DeviceOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${source} não é JSON válido: ${err instanceof Error ? err.message : 'erro desconhecido'}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} deve conter um objeto com aliases/exclude/devices.`);
  }

  const { aliases, exclude, devices } = parsed as Record<string, unknown>;

  return {
    aliases: parseAliases(aliases, source),
    exclude: parseExclude(exclude, source),
    devices: parseManualDevices(devices, source),
  };
}

function parseAliases(value: unknown, source: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${source}: "aliases" deve ser um objeto de apelido → dispositivo.`);
  }
  for (const [key, target] of Object.entries(value)) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(`${source}: alias "${key}" deve apontar para um dispositivo.`);
    }
  }
  return value as Record<string, string>;
}

function parseExclude(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((e) => typeof e !== 'string')) {
    throw new Error(`${source}: "exclude" deve ser uma lista de entity_id.`);
  }
  return value as string[];
}

function parseManualDevices(value: unknown, source: string): DeviceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${source}: "devices" deve ser uma lista.`);
  }

  return value.map((row, index) => {
    const where = `${source}: devices[${index}]`;
    if (typeof row !== 'object' || row === null) {
      throw new Error(`${where} deve ser um objeto.`);
    }
    const { device, room_id: roomId, entity_id: entityId, name } = row as Record<string, unknown>;

    for (const [field, val] of [
      ['device', device],
      ['room_id', roomId],
      ['entity_id', entityId],
    ] as const) {
      if (typeof val !== 'string' || val.length === 0) {
        throw new Error(`${where}: campo "${field}" ausente ou vazio.`);
      }
    }

    try {
      return toDeviceEntry({
        device: device as string,
        roomId: roomId as string,
        entityId: entityId as string,
        ...(typeof name === 'string' ? { name } : {}),
      });
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : 'entrada inválida'}`);
    }
  });
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Mantém o `DeviceRegistry` atualizado a partir do Home Assistant.
 *
 * Descobre no boot e revalida por TTL, para que um dispositivo novo cadastrado
 * no HA fique acionável sem reiniciar o servidor. Nunca lança: HA fora do ar
 * degrada para o último snapshot conhecido, nunca para um registro vazio.
 */
export class DeviceRegistrySource {
  private registry: DeviceRegistry;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly haClient: HomeAssistantClient,
    private readonly overrides: DeviceOverrides = EMPTY_OVERRIDES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {
    // Snapshot inicial só com os overrides: resolve algo mesmo antes do primeiro
    // refresh, e é o estado final caso o HA nunca responda.
    this.registry = this.build([]);
  }

  /** Primeira descoberta e agendamento do refresh. */
  async start(): Promise<void> {
    await this.refresh();

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.ttlMs);
    // Não segurar o processo vivo só pelo refresh do registro.
    this.refreshTimer.unref();
  }

  /**
   * Snapshot atual. Chame a cada uso em vez de guardar a referência, senão o
   * refresh nunca chega a quem resolve.
   */
  current(): DeviceRegistry {
    return this.registry;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(): Promise<void> {
    const startedAt = Date.now();
    const discovered = await this.haClient.listAreaEntities();

    if (discovered === null) {
      getLogger().warn(
        { event: 'device_registry_refresh', count: this.registry.size },
        'Descoberta de dispositivos falhou: mantendo o registro anterior',
      );
      return;
    }

    this.registry = this.build(discovered);

    getLogger().info(
      {
        event: 'device_registry_refresh',
        count: this.registry.size,
        rooms: this.registry.rooms,
        latency_ms: Date.now() - startedAt,
      },
      `Registro de dispositivos atualizado: ${this.registry.size} em ${this.registry.rooms.length} cômodos`,
    );
  }

  /** Overrides manuais vêm depois da descoberta: na mesma chave, eles vencem. */
  private build(discovered: DiscoveredEntity[]): DeviceRegistry {
    const entries: DeviceEntry[] = [];

    for (const row of discovered) {
      try {
        entries.push(
          toDeviceEntry({
            device: row.device,
            roomId: row.room_id,
            entityId: row.entity_id,
            ...(row.name ? { name: row.name } : {}),
          }),
        );
      } catch (err) {
        getLogger().warn(
          { event: 'device_registry_refresh', entity_id: row.entity_id, err },
          'Entidade descoberta ignorada',
        );
      }
    }

    entries.push(...this.overrides.devices);

    return DeviceRegistry.fromEntries(entries, {
      aliases: this.overrides.aliases,
      exclude: this.overrides.exclude,
    });
  }
}
