import { roomLabel } from '../prompts/luna-system-prompt.js';

/**
 * Um dispositivo acionável, já resolvido para uma entidade concreta do Home
 * Assistant. `device` e `roomId` formam a chave: o mesmo `device` ("luz") pode
 * existir em vários cômodos apontando para entidades diferentes.
 */
export interface DeviceEntry {
  /** `object_id` da entidade, ex: `luz_bancada`. É o que a IA fala. */
  device: string;
  /** `area_id` do Home Assistant — a mesma string do `room_id` do satélite. */
  roomId: string;
  /** Entidade completa, ex: `switch.luz_bancada`. */
  entityId: string;
  /** Domínio derivado do `entityId`, ex: `switch`. */
  domain: string;
  /** `friendly_name` do HA, quando houver. Só para log e diagnóstico. */
  name?: string;
}

export type DeviceResolution =
  | { ok: true; entry: DeviceEntry }
  | {
      ok: false;
      reason: 'unknown_device' | 'device_not_in_room';
      /** Mensagem em português, escrita para a IA falar em voz alta. */
      error: string;
    };

export interface DeviceRegistryOptions {
  /** Apelido que a IA tende a falar → `device` real. Ex: `{ luz: 'luz_bancada' }`. */
  aliases?: Record<string, string>;
  /** `entity_id`s que a IA não pode acionar, mesmo estando em uma área. */
  exclude?: string[];
}

/**
 * Registro de dispositivos por cômodo, imutável e sem I/O.
 *
 * A construção é síncrona de propósito: quem descobre os dispositivos no HA e
 * mantém o snapshot atualizado é o `DeviceRegistrySource`. Aqui só se resolve.
 */
export class DeviceRegistry {
  /** Chave `${device}::${roomId}` → entrada. */
  private readonly byDeviceAndRoom = new Map<string, DeviceEntry>();
  /** Todo `device` conhecido, em qualquer cômodo — separa os dois tipos de falha. */
  private readonly knownDevices = new Set<string>();
  private readonly aliases: Map<string, string>;

  private constructor(entries: DeviceEntry[], options: DeviceRegistryOptions) {
    const excluded = new Set((options.exclude ?? []).map(normalize));

    for (const entry of entries) {
      if (excluded.has(normalize(entry.entityId))) continue;

      const roomId = normalize(entry.roomId);

      // Indexado sob o `object_id` e sob o `friendly_name`: são fontes
      // diferentes e nenhuma é confiável sozinha. O ESPHome gera object_ids
      // como `luz_bancada_luz_bancada`, que nenhum modelo vai falar; já o
      // friendly_name é o que a pessoa escreveu no HA.
      for (const name of [entry.device, entry.name]) {
        if (!name) continue;
        const device = normalize(name);
        this.byDeviceAndRoom.set(key(device, roomId), entry);
        this.knownDevices.add(device);
      }
    }

    this.aliases = new Map(
      Object.entries(options.aliases ?? {}).map(([from, to]) => [
        normalize(from),
        normalize(to),
      ]),
    );
  }

  static fromEntries(
    entries: DeviceEntry[],
    options: DeviceRegistryOptions = {},
  ): DeviceRegistry {
    return new DeviceRegistry(entries, options);
  }

  /**
   * Resolve o `device` falado contra o cômodo da sessão.
   *
   * `roomId` vem sempre da sessão, nunca dos argumentos gerados pelo modelo:
   * ele alucina o cômodo e o valor errado passaria batido (ver ADR 002).
   */
  resolve(device: string, roomId: string): DeviceResolution {
    const requested = normalize(device);
    const resolvedDevice = this.aliases.get(requested) ?? requested;
    const room = normalize(roomId);

    const entry = this.byDeviceAndRoom.get(key(resolvedDevice, room));
    if (entry) {
      return { ok: true, entry };
    }

    // Existe em outro cômodo: é um erro diferente, e dizer isso em voz alta é
    // mais útil que "não encontrei" — o usuário provavelmente errou o cômodo.
    if (this.knownDevices.has(resolvedDevice)) {
      return {
        ok: false,
        reason: 'device_not_in_room',
        error: `não há "${device}" ${inRoom(roomId)}`,
      };
    }

    return {
      ok: false,
      reason: 'unknown_device',
      error: `não encontrei o dispositivo "${device}"`,
    };
  }

  /** Dispositivos de um cômodo, para log e diagnóstico. */
  devicesInRoom(roomId: string): DeviceEntry[] {
    const room = normalize(roomId);
    return this.distinctEntries().filter((entry) => normalize(entry.roomId) === room);
  }

  /** Quantidade de entidades distintas — cada uma pode ter mais de uma chave. */
  get size(): number {
    return this.distinctEntries().length;
  }

  get rooms(): string[] {
    return [...new Set(this.distinctEntries().map((e) => e.roomId))];
  }

  /** O índice tem uma chave por nome; a entidade é única pelo `entityId`. */
  private distinctEntries(): DeviceEntry[] {
    const byEntity = new Map<string, DeviceEntry>();
    for (const entry of this.byDeviceAndRoom.values()) {
      byEntity.set(entry.entityId, entry);
    }
    return [...byEntity.values()];
  }
}

/**
 * Deriva o domínio e monta a entrada a partir de um `entity_id`.
 * Lança em entidade sem domínio: um `entity_id` malformado só produziria
 * chamadas inválidas ao HA depois, longe da causa.
 */
export function toDeviceEntry(raw: {
  device: string;
  roomId: string;
  entityId: string;
  name?: string;
}): DeviceEntry {
  const domain = raw.entityId.split('.')[0];
  if (!domain || !raw.entityId.includes('.')) {
    throw new Error(
      `entity_id inválido: "${raw.entityId}". Esperado no formato "dominio.objeto".`,
    );
  }
  return { ...raw, domain };
}

/**
 * `roomLabel` devolve o rótulo com artigo ("a cozinha"); a mensagem é falada,
 * então "em a cozinha" não serve. Contrai para "na cozinha" / "no quarto".
 */
function inRoom(roomId: string): string {
  const label = roomLabel(roomId);
  if (label.startsWith('a ')) return `na ${label.slice(2)}`;
  if (label.startsWith('o ')) return `no ${label.slice(2)}`;
  return `em ${label}`;
}

/**
 * Casa o que o modelo fala com o que o HA registra. Só caixa e espaço — nada de
 * casamento aproximado, que é justamente como se aciona o dispositivo errado
 * sem erro nenhum.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function key(device: string, roomId: string): string {
  return `${device}::${roomId}`;
}
