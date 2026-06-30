import type { WebSocket } from 'ws';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { CompletedTurn } from '../providers/types.js';
import { getLogger } from '../logging/logger.js';
import { TtfabTracker } from '../metrics/ttfab.js';
import { getActiveProviderName } from '../providers/AudioProviderFactory.js';
import type { AppConfig } from '../config/env.js';
import {
  createEnvelope,
  serializeControlMessage,
} from '../ws/protocol.js';

export class Orchestrator {
  private readonly ttfabByRoom = new Map<string, TtfabTracker>();
  private readonly speakingByRoom = new Map<string, boolean>();

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
  ) {}

  async handleAudioChunk(
    roomId: string,
    deviceId: string,
    pcm: Buffer,
    sendToClient: (data: Buffer | string) => void,
  ): Promise<void> {
    const tracker = this.getTtfabTracker(roomId);
    tracker.markClientAudioReceived();

    this.roomManager.getRingBuffer().touch(roomId);

    const provider = await this.roomManager.getOrCreateProvider(roomId);
    this.bindProviderCallbacksOnce(roomId, deviceId, provider, sendToClient);

    provider.sendAudio(pcm);
  }

  private readonly boundProviders = new WeakSet<object>();

  private bindProviderCallbacksOnce(
    roomId: string,
    deviceId: string,
    provider: import('../providers/IAudioProvider.js').IAudioProvider,
    sendToClient: (data: Buffer | string) => void,
  ): void {
    if (this.boundProviders.has(provider)) return;
    this.boundProviders.add(provider);

    const tracker = this.getTtfabTracker(roomId);
    const providerName = getActiveProviderName(this.config);

    provider.onAudioResponse((chunk) => {
      const latencyMs = tracker.markFirstResponseSent(roomId, providerName);
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

      const header = serializeControlMessage(
        createEnvelope('audio_response', roomId, { seq: Date.now() }),
      );
      const headerBuf = Buffer.from(header, 'utf8');
      const combined = Buffer.concat([headerBuf, chunk]);
      sendToClient(combined);
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
