import type { WebSocket } from 'ws';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { CompletedTurn } from '../providers/types.js';
import { isControlDeviceCall } from '../providers/types.js';
import { getLogger } from '../logging/logger.js';
import { TtfabTracker } from '../metrics/ttfab.js';
import { getActiveProviderName } from '../providers/AudioProviderFactory.js';
import type { AppConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import type { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import {
  createEnvelope,
  serializeControlMessage,
} from '../ws/protocol.js';

export class Orchestrator {
  private readonly ttfabByRoom = new Map<string, TtfabTracker>();
  private readonly speakingByRoom = new Map<string, boolean>();
  // Provider é cacheado por cômodo (RoomManager) e sobrevive à reconexão do
  // satélite; a conexão WS, não. Se o dispositivo cair sem handshake de close
  // (queda de energia, cabo USB arrancado — não manda close frame) e o
  // servidor não perceber, `bindProviderCallbacksOnce` roda só uma vez por
  // provider e prenderia a resposta para sempre no `sendToClient` da conexão
  // morta. Indireção por cômodo: cada chunk de áudio atualiza a entrada, e as
  // respostas saem sempre pela conexão mais recente, não pela que existia
  // quando o provider foi criado.
  private readonly sendToClientByRoom = new Map<string, (data: Buffer | string) => void>();

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
    private readonly haClient: HomeAssistantClient,
    private readonly deviceRegistry: DeviceRegistrySource,
  ) {}

  async handleAudioChunk(
    roomId: string,
    deviceId: string,
    pcm: Buffer,
    sendToClient: (data: Buffer | string) => void,
  ): Promise<void> {
    const tracker = this.getTtfabTracker(roomId);
    tracker.markClientAudioReceived();

    this.sendToClientByRoom.set(roomId, sendToClient);
    this.roomManager.getRingBuffer().touch(roomId);

    const provider = await this.roomManager.getOrCreateProvider(roomId);
    this.bindProviderCallbacksOnce(roomId, deviceId, provider);

    provider.sendAudio(pcm);
  }

  /**
   * Fim de fala explícito (botão solto no satélite): âncora exata do TTFAB.
   * No modo open-mic a âncora vem da transcrição de entrada do provider —
   * ver `TtfabTracker`.
   */
  async handleActivityEnd(roomId: string): Promise<void> {
    this.getTtfabTracker(roomId).markUserSpeech();

    const provider = await this.roomManager.getOrCreateProvider(roomId);
    provider.signalActivityEnd();
  }

  private readonly boundProviders = new WeakSet<object>();

  private bindProviderCallbacksOnce(
    roomId: string,
    deviceId: string,
    provider: import('../providers/IAudioProvider.js').IAudioProvider,
  ): void {
    if (this.boundProviders.has(provider)) return;
    this.boundProviders.add(provider);

    const tracker = this.getTtfabTracker(roomId);
    const providerName = getActiveProviderName(this.config);

    // Nunca captura o `sendToClient` do momento do bind (só acontece uma vez,
    // na primeira mensagem do cômodo): resolve pela entrada mais recente do
    // mapa a cada envio, para sobreviver a reconexões do satélite.
    const sendToClient = (data: Buffer | string): void => {
      this.sendToClientByRoom.get(roomId)?.(data);
    };

    provider.onUserSpeech(() => tracker.markUserSpeech());

    provider.onAudioResponse((chunk) => {
      const latencyMs = tracker.markFirstResponseSent();
      if (latencyMs !== null) {
        getLogger().info(
          {
            event: 'ttfab',
            room_id: roomId,
            device_id: deviceId,
            provider: providerName,
            latency_ms: latencyMs,
          },
          `TTFAB: ${latencyMs}ms`,
        );
      }

      if (!this.speakingByRoom.get(roomId)) {
        this.speakingByRoom.set(roomId, true);
        sendToClient(
          serializeControlMessage(createEnvelope('speaking_start', roomId)),
        );
      }

      // Fragmenta a resposta em frames pequenos. Satélites embarcados
      // (ESP32 / arduinoWebSockets) fecham a conexão ao receber um frame
      // binário grande; o cliente de testes (Node) aceita qualquer tamanho.
      const MAX_AUDIO_FRAME_BYTES = 1024; // múltiplo de 2 (PCM16)
      for (let offset = 0; offset < chunk.length; offset += MAX_AUDIO_FRAME_BYTES) {
        const piece = chunk.subarray(offset, offset + MAX_AUDIO_FRAME_BYTES);
        const header = serializeControlMessage(
          createEnvelope('audio_response', roomId, { seq: Date.now() }),
        );
        const headerBuf = Buffer.from(header, 'utf8');
        sendToClient(Buffer.concat([headerBuf, piece]));
      }
    });

    provider.onTurnComplete((turn: CompletedTurn) => {
      if (turn.userText || turn.assistantText) {
        this.roomManager
          .getRingBuffer()
          .appendTurn(roomId, turn.userText ?? '', turn.assistantText ?? '');
      }

      if (this.speakingByRoom.get(roomId)) {
        this.speakingByRoom.set(roomId, false);
        sendToClient(
          serializeControlMessage(createEnvelope('speaking_end', roomId)),
        );
      }

      tracker.reset();
    });

    provider.onToolCall((call) => {
      // Fronteira de confiança: `args` é texto gerado pelo modelo.
      if (!isControlDeviceCall(call)) {
        getLogger().error(
          { event: 'tool_call', room_id: roomId, name: call.name, args: call.args },
          'Tool call inválida ou desconhecida',
        );
        provider.sendToolResult(call.callId, {
          success: false,
          error: 'argumentos inválidos',
        });
        return;
      }

      // Marco do ciclo completo: tool call recebida → HA executado → resposta
      // devolvida. O `latency_ms` do HomeAssistantClient mede só o HTTP; o que
      // o usuário sente é este intervalo, que inclui resolução no registro.
      const toolStartedAt = Date.now();
      // Latência do modelo: fim da fala → decisão de chamar a tool. É o termo
      // dominante do atraso percebido; o despacho no HA fica na casa dos 15ms.
      const modelDecisionMs = tracker.elapsedSinceAnchor();

      const { device, action } = call.args;

      // O `room_id` do modelo é descartado: ele alucina o cômodo (visto em
      // teste, sessão em sala_de_estar gerando room_id "cozinha") e os args
      // continuariam válidos pelo type guard — acionaria o cômodo errado sem
      // erro nenhum. O servidor sabe de onde veio o áudio; essa é a verdade.
      const suggestedRoomId = call.args.room_id;

      getLogger().info(
        {
          event: 'tool_call',
          room_id: roomId,
          device_id: deviceId,
          name: call.name,
          device,
          action,
          ...(suggestedRoomId !== roomId ? { discarded_room_id: suggestedRoomId } : {}),
        },
        `Comando de automação: ${device} → ${action} em ${roomId}`,
      );

      // `current()` a cada chamada, nunca em campo: o registro é revalidado em
      // background e uma referência guardada congelaria o vocabulário no boot.
      const resolution = this.deviceRegistry.current().resolve(device, roomId);

      if (!resolution.ok) {
        getLogger().warn(
          {
            event: 'device_unresolved',
            room_id: roomId,
            device_id: deviceId,
            device,
            reason: resolution.reason,
          },
          `Dispositivo não resolvido: ${device} em ${roomId} (${resolution.reason})`,
        );
        // Sem `command_result`: nada foi acionado. O erro é escrito para ser
        // falado — é assim que a IA diz "não encontrei esse dispositivo" em vez
        // de encerrar o turno em silêncio.
        provider.sendToolResult(call.callId, {
          success: false,
          error: resolution.error,
        });
        return;
      }

      const { domain, entityId } = resolution.entry;

      // O callback do port é síncrono; a chamada ao HA é async e o client
      // nunca lança, então basta não deixar a promise solta.
      void this.haClient
        .callService(domain, action === 'on' ? 'turn_on' : 'turn_off', entityId)
        .then((result) => {
          const latencyMs = Date.now() - toolStartedAt;

          getLogger().info(
            {
              event: 'command_dispatch',
              room_id: roomId,
              device_id: deviceId,
              device,
              action,
              entity_id: entityId,
              success: result.success,
              latency_ms: latencyMs,
              ...(modelDecisionMs !== null ? { model_decision_ms: modelDecisionMs } : {}),
            },
            `Comando despachado: ${device} → ${action} (${latencyMs}ms` +
              (modelDecisionMs !== null ? `, modelo: ${modelDecisionMs}ms)` : ')'),
          );

          // `success` reflete o resultado real: o satélite não pode tratar um
          // HA fora do ar como comando executado.
          sendToClient(
            serializeControlMessage(
              createEnvelope('command_result', roomId, {
                success: result.success,
                device,
                action,
                entity_id: entityId,
              }),
            ),
          );

          provider.sendToolResult(call.callId, result);
        });
    });

    provider.onError((err) => {
      getLogger().error(
        { room_id: roomId, device_id: deviceId, provider: providerName, err: err.message },
        'Erro no provider de áudio',
      );
    });
  }

  private getTtfabTracker(roomId: string): TtfabTracker {
    let tracker = this.ttfabByRoom.get(roomId);
    if (!tracker) {
      tracker = new TtfabTracker();
      this.ttfabByRoom.set(roomId, tracker);
    }
    return tracker;
  }
}

export interface ClientConnection {
  ws: WebSocket;
  roomId: string;
  deviceId: string;
  authenticated: boolean;
}
