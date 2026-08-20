import type { HomeAssistantClient } from '../../ha/HomeAssistantClient.js';
import type { DeviceRegistrySource } from '../../ha/deviceRegistrySource.js';
import { CONTROL_DEVICE_TOOL, isControlDeviceArgs } from '../../providers/types.js';
import { getLogger } from '../../logging/logger.js';
import { createEnvelope, serializeControlMessage } from '../../ws/protocol.js';
import type { SendToRoom } from '../Orchestrator.js';
import { INVALID_ARGS_RESULT, type ToolHandler } from './types.js';

export interface ControlDeviceDeps {
  haClient: HomeAssistantClient;
  deviceRegistry: DeviceRegistrySource;
  sendToRoom: SendToRoom;
}

/**
 * Handler da única tool de hoje: liga/desliga um aparelho no Home Assistant.
 *
 * O `await` no HA é de propósito. Com a verificação de estado fora do caminho
 * crítico ele custa só o POST (~20-40 ms) e preserva o único sinal de falha
 * verdadeiro (HA fora do ar, 401, timeout); responder otimista antes do POST
 * faria a Luna confirmar em voz um comando que falhou de fato.
 */
export function createControlDeviceHandler(deps: ControlDeviceDeps): ToolHandler {
  return async (args, ctx) => {
    if (!isControlDeviceArgs(args)) {
      getLogger().error(
        { event: 'tool_call', room_id: ctx.roomId, name: CONTROL_DEVICE_TOOL.name, args },
        'Tool call inválida ou desconhecida',
      );
      return INVALID_ARGS_RESULT;
    }

    // Marco do ciclo completo: tool call recebida → HA executado → resposta
    // devolvida. O `latency_ms` do HomeAssistantClient mede só o HTTP; o que
    // o usuário sente é este intervalo, que inclui resolução no registro.
    const toolStartedAt = Date.now();
    const { device, action } = args;

    // O `room_id` do modelo é descartado: ele alucina o cômodo (visto em
    // teste, sessão em sala_de_estar gerando room_id "cozinha") e os args
    // continuariam válidos pelo type guard — acionaria o cômodo errado sem
    // erro nenhum. O servidor sabe de onde veio o áudio; essa é a verdade.
    const suggestedRoomId = args.room_id;

    getLogger().info(
      {
        event: 'tool_call',
        room_id: ctx.roomId,
        device_id: ctx.deviceId,
        name: CONTROL_DEVICE_TOOL.name,
        device,
        action,
        ...(suggestedRoomId !== ctx.roomId ? { discarded_room_id: suggestedRoomId } : {}),
      },
      `Comando de automação: ${device} → ${action} em ${ctx.roomId}`,
    );

    // `current()` a cada chamada, nunca em campo: o registro é revalidado em
    // background e uma referência guardada congelaria o vocabulário no boot.
    const resolution = deps.deviceRegistry.current().resolve(device, ctx.roomId);

    if (!resolution.ok) {
      getLogger().warn(
        {
          event: 'device_unresolved',
          room_id: ctx.roomId,
          device_id: ctx.deviceId,
          device,
          reason: resolution.reason,
        },
        `Dispositivo não resolvido: ${device} em ${ctx.roomId} (${resolution.reason})`,
      );
      // Sem `command_result`: nada foi acionado. O erro é escrito para ser
      // falado — é assim que a IA diz "não encontrei esse dispositivo" em vez
      // de encerrar o turno em silêncio.
      return { success: false, error: resolution.error };
    }

    const { domain, entityId } = resolution.entry;

    const result = await deps.haClient.callService(
      domain,
      action === 'on' ? 'turn_on' : 'turn_off',
      entityId,
    );

    const latencyMs = Date.now() - toolStartedAt;

    getLogger().info(
      {
        event: 'command_dispatch',
        room_id: ctx.roomId,
        device_id: ctx.deviceId,
        device,
        action,
        entity_id: entityId,
        success: result.success,
        latency_ms: latencyMs,
        ...(ctx.modelDecisionMs !== null ? { model_decision_ms: ctx.modelDecisionMs } : {}),
      },
      `Comando despachado: ${device} → ${action} (${latencyMs}ms` +
        (ctx.modelDecisionMs !== null ? `, modelo: ${ctx.modelDecisionMs}ms)` : ')'),
    );

    // `success` reflete o resultado real: o satélite não pode tratar um HA
    // fora do ar como comando executado.
    deps.sendToRoom(
      ctx.roomId,
      serializeControlMessage(
        createEnvelope('command_result', ctx.roomId, {
          success: result.success,
          device,
          action,
          entity_id: entityId,
        }),
      ),
    );

    return result;
  };
}
