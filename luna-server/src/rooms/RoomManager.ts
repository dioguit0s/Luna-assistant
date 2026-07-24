import type { AppConfig } from '../config/env.js';
import { createAudioProvider } from '../providers/AudioProviderFactory.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import { CONTROL_DEVICE_TOOL } from '../providers/types.js';
import { buildLunaSystemPrompt } from '../prompts/luna-system-prompt.js';
import { ConversationRingBuffer } from './ConversationRingBuffer.js';
import { getLogger } from '../logging/logger.js';

interface RoomSession {
  provider: IAudioProvider;
}

export class RoomManager {
  private readonly sessions = new Map<string, RoomSession>();
  private readonly clientCounts = new Map<string, number>();
  private readonly pendingConnections = new Map<string, Promise<IAudioProvider>>();

  constructor(
    private readonly config: AppConfig,
    private readonly ringBuffer: ConversationRingBuffer,
  ) {}

  async getOrCreateProvider(roomId: string): Promise<IAudioProvider> {
    const existing = this.sessions.get(roomId);
    if (existing) {
      return existing.provider;
    }

    const pending = this.pendingConnections.get(roomId);
    if (pending) {
      return pending;
    }

    const connectionPromise = this.createProviderSession(roomId);
    this.pendingConnections.set(roomId, connectionPromise);

    try {
      return await connectionPromise;
    } finally {
      this.pendingConnections.delete(roomId);
    }
  }

  private async createProviderSession(roomId: string): Promise<IAudioProvider> {
    const provider = createAudioProvider(this.config);
    const history = this.ringBuffer.getHistory(roomId);
    const systemPrompt = buildLunaSystemPrompt(roomId, history);

    await provider.connect({
      roomId,
      systemPrompt,
      history,
      tools: [CONTROL_DEVICE_TOOL],
    });

    this.sessions.set(roomId, { provider });
    getLogger().info({ room_id: roomId, event: 'room_created' }, 'Sala criada');

    return provider;
  }

  /**
   * O provider encerrou a sessão sozinho por ociosidade (ver
   * `IAudioProvider.onSessionEnded`) — o satélite continua conectado, então
   * `unregisterClient` nunca dispararia. Só descarta a entrada; a próxima
   * fala passa de novo por `getOrCreateProvider` e cria uma sessão nova.
   */
  evictRoom(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (!session) return;

    this.sessions.delete(roomId);
    // Best-effort: o provider já fechou a sessão sozinho antes de avisar; isto
    // só garante que ele não reaja mais a nenhum evento tardio.
    void session.provider.disconnect();
    getLogger().info(
      { room_id: roomId, event: 'room_session_expired' },
      'Sessão do provider expirou por ociosidade; sala será recriada na próxima fala',
    );
  }

  registerClient(roomId: string): void {
    this.clientCounts.set(roomId, (this.clientCounts.get(roomId) ?? 0) + 1);
  }

  async unregisterClient(roomId: string): Promise<void> {
    const count = (this.clientCounts.get(roomId) ?? 1) - 1;
    if (count <= 0) {
      this.clientCounts.delete(roomId);
      const session = this.sessions.get(roomId);
      if (session) {
        await session.provider.disconnect();
        this.sessions.delete(roomId);
        getLogger().info({ room_id: roomId, event: 'room_destroyed' }, 'Sala encerrada');
      }
    } else {
      this.clientCounts.set(roomId, count);
    }
  }

  getRingBuffer(): ConversationRingBuffer {
    return this.ringBuffer;
  }

  async destroy(): Promise<void> {
    for (const [roomId, session] of this.sessions) {
      await session.provider.disconnect();
      getLogger().info({ room_id: roomId }, 'Sala encerrada no shutdown');
    }
    this.sessions.clear();
    this.pendingConnections.clear();
  }
}
