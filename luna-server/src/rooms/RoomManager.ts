import type { AppConfig } from '../config/env.js';
import { createAudioProvider } from '../providers/AudioProviderFactory.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import { CONTROL_DEVICE_TOOL } from '../providers/types.js';
import { SET_REMINDER_TOOL } from '../reminders/tools.js';
import { buildLunaSystemPrompt } from '../prompts/luna-system-prompt.js';
import { ConversationRingBuffer } from './ConversationRingBuffer.js';
import { getLogger } from '../logging/logger.js';

interface RoomSession {
  provider: IAudioProvider;
}

/** Registra os callbacks do port num provider recém-criado. Ver `setProviderBinder`. */
export type ProviderBinder = (roomId: string, provider: IAudioProvider) => void;

export class RoomManager {
  private readonly sessions = new Map<string, RoomSession>();
  private readonly clientCounts = new Map<string, number>();
  private readonly pendingConnections = new Map<string, Promise<IAudioProvider>>();
  private bindProvider: ProviderBinder = () => {};

  constructor(
    private readonly config: AppConfig,
    private readonly ringBuffer: ConversationRingBuffer,
    /** Injetável para teste (timeout de connect): mesmo padrão do `fetchImpl` de `HomeAssistantClient`. */
    private readonly providerFactory: (config: AppConfig) => IAudioProvider = createAudioProvider,
  ) {}

  /**
   * O Orchestrator registra aqui, no construtor dele, o bind dos callbacks do
   * provider — exatamente um binder, sobrescrito se chamado duas vezes.
   *
   * Antes o bind acontecia no primeiro `handleAudioChunk`. Um provider criado
   * por qualquer outro caminho — o disparo de alarme, que fala sem ter sido
   * perguntado — nasceria sem `onAudioResponse` registrado, e a fala seria
   * gerada e cairia no vazio, sem erro nenhum.
   */
  setProviderBinder(bind: ProviderBinder): void {
    this.bindProvider = bind;
  }

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
    const provider = this.providerFactory(this.config);
    const history = this.ringBuffer.getHistory(roomId);
    const systemPrompt = buildLunaSystemPrompt(roomId, history);

    const connectPromise = provider.connect({
      roomId,
      systemPrompt,
      history,
      tools: [CONTROL_DEVICE_TOOL, SET_REMINDER_TOOL],
    });

    await this.awaitConnectWithTimeout(roomId, provider, connectPromise);

    // Antes de `sessions.set`: nenhum caminho pode alcançar este provider sem
    // os callbacks já registrados.
    this.bindProvider(roomId, provider);

    this.sessions.set(roomId, { provider });
    getLogger().info({ room_id: roomId, event: 'room_created' }, 'Sala criada');

    return provider;
  }

  /**
   * Teto para `connect()`: num blackhole de rede (Wi-Fi de pé, internet fora)
   * a promise do SDK do Gemini/OpenAI nunca resolve nem rejeita. Sem isto,
   * `getOrCreateProvider` entregaria a mesma promise pendurada para sempre a
   * todo chunk de áudio seguinte — a sala ficaria muda até o processo
   * reiniciar, sem log nenhum apontando a causa.
   *
   * A `connectPromise` original não é cancelável (o SDK não expõe isso), então
   * no estouro ela continua em voo. Se acabar resolvendo depois do prazo, o
   * `.then` abaixo desconecta a sessão assim que ela assentar — chamar
   * `provider.disconnect()` *antes* disso arriscaria uma corrida com o próprio
   * `connect()` do adapter (o `disposed` dos dois adapters só é checado antes
   * do `await` interno, não depois: um `disconnect()` prematuro marcaria
   * `disposed = true` sem sessão ainda atribuída, e o `connect()` sobrescreveria
   * `this.session` com uma sessão "viva" logo em seguida — vazando a conexão
   * paga do provedor sem que nada a feche).
   */
  private async awaitConnectWithTimeout(
    roomId: string,
    provider: IAudioProvider,
    connectPromise: Promise<void>,
  ): Promise<void> {
    const timeoutMs = this.config.providerConnectTimeoutMs;
    let timedOut = false;

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Timeout ao conectar o provider de áudio (${timeoutMs}ms, room_id=${roomId})`));
      }, timeoutMs);
      timer.unref();
    });

    try {
      await Promise.race([connectPromise, timeout]);
    } catch (err) {
      if (timedOut) {
        getLogger().error(
          { room_id: roomId, event: 'provider_connect_timeout', timeout_ms: timeoutMs },
          'connect() do provider de áudio excedeu o teto: sala não criada',
        );
        void connectPromise
          .then(() => {
            getLogger().warn(
              { room_id: roomId, event: 'provider_connect_timeout_late_success' },
              'connect() do provider resolveu depois do teto: desconectando sessão órfã',
            );
            return provider.disconnect();
          })
          .catch(() => {
            // connect() também rejeitou, só que depois do teto — nada para
            // desconectar, o erro relevante já foi logado/propagado acima.
          });
      }
      throw err;
    }
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

  /**
   * @returns `true` quando este era o último cliente da sala e a sessão do
   * provider foi de fato encerrada — sinal para o chamador (`WsServer`)
   * liberar também o estado por sala do `Orchestrator` (ver
   * `Orchestrator.releaseRoom`). `false` quando ainda há outro cliente
   * conectado à mesma sala e a sessão continua viva para ele.
   */
  async unregisterClient(roomId: string): Promise<boolean> {
    const count = (this.clientCounts.get(roomId) ?? 1) - 1;
    if (count <= 0) {
      this.clientCounts.delete(roomId);
      const session = this.sessions.get(roomId);
      if (session) {
        await session.provider.disconnect();
        this.sessions.delete(roomId);
        getLogger().info({ room_id: roomId, event: 'room_destroyed' }, 'Sala encerrada');
      }
      return true;
    }
    this.clientCounts.set(roomId, count);
    return false;
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
