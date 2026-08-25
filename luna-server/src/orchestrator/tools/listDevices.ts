import type { DeviceEntry } from '../../ha/deviceRegistry.js';
import { inRoom } from '../../ha/deviceRegistry.js';
import type { DeviceRegistrySource } from '../../ha/deviceRegistrySource.js';
import { isListDevicesArgs, LIST_DEVICES_TOOL } from '../../ha/tools.js';
import { roomLabel } from '../../prompts/luna-system-prompt.js';
import { getLogger } from '../../logging/logger.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

export interface ListDevicesDeps {
  deviceRegistry: DeviceRegistrySource;
}

/**
 * Handler de `list_devices` — a única tool de hoje que aceita o `room_id`
 * gerado pelo modelo (ver ADR 009). É uma exceção consciente ao ADR 002: como
 * a tool só lê, um cômodo alucinado vira uma resposta falada errada, que o
 * usuário percebe na hora — diferente de `control_device`, onde acionaria o
 * aparelho errado em silêncio. `resolveRoom` valida contra o registro antes
 * de aceitar; sem cômodo dito, ou com um que não existe, cai no cômodo da
 * sessão.
 *
 * Zero I/O: só lê o snapshot em memória do `DeviceRegistrySource`, igual
 * `getWeather.ts`. `current()` a cada chamada, nunca guardado em campo — o
 * registro é revalidado em background e uma referência guardada congelaria o
 * vocabulário no boot (mesmo motivo de `controlDevice.ts`).
 */
export function createListDevicesHandler(deps: ListDevicesDeps): ToolHandler {
  return async (args, ctx) => {
    if (!isListDevicesArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: LIST_DEVICES_TOOL.name, args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    const registry = deps.deviceRegistry.current();

    if (registry.size === 0) {
      getLogger().warn(
        { event: 'device_list_empty_registry', room_id: ctx.roomId },
        'Listagem de dispositivos pedida com o registro vazio',
      );
      return { success: false, error: 'ainda não conheço nenhum aparelho da casa' };
    }

    const requested = args.room_id?.trim() || undefined;
    const matched = requested ? registry.resolveRoom(requested) : null;
    // Cômodo pedido que não existe não é erro: cai no cômodo da sessão, e o
    // sinalizador abaixo deixa a Luna dizer "não conheço esse ambiente" antes
    // de listar o que há aqui — em vez de silenciosamente listar o lugar errado.
    const room = matched ?? ctx.roomId;
    const unknownRoom = requested && !matched ? requested : null;

    const devices = spokenNames(registry.devicesInRoom(room));
    const rooms = registry.rooms;

    getLogger().info(
      {
        event: 'tool_call',
        room_id: ctx.roomId,
        device_id: ctx.deviceId,
        name: LIST_DEVICES_TOOL.name,
        listed_room_id: room,
        count: devices.length,
        ...(unknownRoom ? { unknown_room: unknownRoom } : {}),
        ...(ctx.modelDecisionMs !== null ? { model_decision_ms: ctx.modelDecisionMs } : {}),
      },
      `Listagem de dispositivos: ${devices.length} em ${room}`,
    );

    if (unknownRoom) {
      getLogger().warn(
        { event: 'device_list_unknown_room', room_id: ctx.roomId, requested_room: unknownRoom },
        `Cômodo pedido não existe no registro: ${unknownRoom}`,
      );
    }

    return {
      success: true,
      room: roomLabel(room),
      count: devices.length,
      devices,
      spoken:
        devices.length > 0 ? joinSpoken(devices) : `nenhum aparelho ${inRoom(room)}`,
      rooms: rooms.map(roomLabel),
      ...(unknownRoom ? { unknown_room: unknownRoom } : {}),
    };
  };
}

/**
 * `friendly_name` quando existe — é o que a pessoa escreveu no HA; senão o
 * `object_id` humanizado. Dedupa por nome (duas entidades podem compartilhar
 * `friendly_name`) e ordena para a saída ser determinística.
 */
function spokenNames(entries: DeviceEntry[]): string[] {
  const names = entries.map((entry) => (entry.name ?? entry.device).replace(/_/g, ' ').trim());
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** "a" / "a e b" / "a, b e c" — para o modelo falar a lista sem remontá-la. */
function joinSpoken(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}
