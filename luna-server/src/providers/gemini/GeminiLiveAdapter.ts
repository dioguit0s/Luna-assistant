import { GoogleGenAI, Modality, EndSensitivity } from '@google/genai';
import type { AutomaticActivityDetection } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { IAudioProvider } from '../IAudioProvider.js';
import type { CompletedTurn, ProviderSessionConfig, ToolCall } from '../types.js';
import { createDownsampler24kTo16k, type RationalResampler } from '../utils/resampler.js';
import { AudioDump } from '../utils/audioDump.js';
import { getLogger } from '../../logging/logger.js';
import {
  normalizeToolCalls,
  toGeminiFunctionDeclarations,
  type RawToolCall,
} from './tool-mapping.js';

type LiveSession = Awaited<
  ReturnType<InstanceType<typeof GoogleGenAI>['live']['connect']>
>;

// Sala fica aberta indefinidamente enquanto o satélite não desconectar (wake
// word local: ele só pinga, nunca cai sozinho) — renovar a sessão a cada
// `goAway` incondicionalmente manteria uma conexão Live paga rodando 24/7
// mesmo sem ninguém falando. Só vale renovar (e pagar o custo de manter a
// sessão viva) se a conversa está de fato em andamento; caso contrário deixa
// morrer e recria sob demanda na próxima fala, como no primeiro `connect`.
const ACTIVE_CONVERSATION_WINDOW_MS = 60_000;

export class GeminiLiveAdapter implements IAudioProvider {
  private ai: GoogleGenAI | null = null;
  private session: LiveSession | null = null;
  private sessionConfig: ProviderSessionConfig | null = null;
  // Diagnostico: so grava com AUDIO_DUMP_DIR setado (ver AudioDump).
  private readonly dump = new AudioDump('gemini');
  // Reamostrador do downlink (24kHz -> 16kHz), com estado por SESSAO (nao por
  // turno nem por chunk): o audio dentro de uma sessao e um unico stream
  // continuo mesmo aparecendo em turnos separados no protocolo. reset() so
  // roda em openLiveSession, entao cobre o connect() inicial e a renovacao
  // por goAway (renewSession) - os dois unicos pontos onde uma sessao nasce.
  private readonly downlink: RationalResampler = createDownsampler24kTo16k();
  private audioResponseCb: ((chunk: Buffer) => void) | null = null;
  private turnCompleteCb: ((turn: CompletedTurn) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private toolCallCb: ((call: ToolCall) => void) | null = null;
  private userSpeechCb: (() => void) | null = null;
  private sessionEndedCb: (() => void) | null = null;
  private lastAudioAt: number | null = null;
  private userTranscript = '';
  private assistantTranscript = '';
  private activityOpen = false;
  private roomId = '';
  private disposed = false;
  /**
   * Incrementado a cada sessão aberta (connect inicial ou renovação). O
   * `onclose` de cada sessão captura o valor vigente no momento em que foi
   * criada: `renewSession` fecha a sessão antiga *depois* de já ter trocado
   * `this.session` pela nova, então o `onclose` assíncrono da antiga chegaria
   * tarde e, sem este guard, apagaria a sessão nova que acabou de substituí-la.
   */
  private sessionGeneration = 0;
  /** Evita reconexões concorrentes: um `goAway` chegando durante outra reconexão em voo é no-op. */
  private reconnecting = false;
  /** callId → nome da função. O SDK exige o `name` de volta no `functionResponse`. */
  private readonly pendingToolCalls = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    /**
     * Injetável para teste (guarda de `sessionGeneration` contra `onclose`
     * tardio de uma sessão renovada): mesmo padrão do `fetchImpl` de
     * `HomeAssistantClient` e do `providerFactory` de `RoomManager`.
     */
    private readonly createClient: (apiKey: string) => GoogleGenAI = (apiKey) =>
      new GoogleGenAI({ apiKey }),
  ) {}

  /**
   * Dispara `sessionEndedCb` no máximo uma vez por sessão: `session` vira
   * `null` aqui, e essa é a própria guarda contra notificação duplicada
   * (goAway ocioso, `onclose` do socket e falha de `sendAudio` podem
   * disputar a mesma sessão morta).
   */
  private notifySessionEnded(): void {
    if (this.session === null) return;
    this.session = null;
    this.sessionEndedCb?.();
  }

  /**
   * Janela de silêncio do VAD entra direto no caminho crítico do TTFAB: o Gemini
   * só começa a gerar depois de confirmar o fim da fala. Sem override, o default
   * do SDK é END_SENSITIVITY_LOW (fecha o turno mais tarde).
   */
  private buildActivityDetection(): AutomaticActivityDetection | undefined {
    const { geminiVadSilenceMs, geminiVadEndSensitivity, geminiManualActivity } = this.config;

    // Push-to-talk: o satélite sabe o instante exato em que o botão foi solto,
    // então não faz sentido pagar o endpointing por áudio do servidor.
    if (geminiManualActivity) {
      return { disabled: true };
    }

    if (geminiVadSilenceMs === null && geminiVadEndSensitivity === null) {
      return undefined;
    }

    return {
      ...(geminiVadSilenceMs !== null ? { silenceDurationMs: geminiVadSilenceMs } : {}),
      ...(geminiVadEndSensitivity !== null
        ? {
            endOfSpeechSensitivity:
              geminiVadEndSensitivity === 'HIGH'
                ? EndSensitivity.END_SENSITIVITY_HIGH
                : EndSensitivity.END_SENSITIVITY_LOW,
          }
        : {}),
    };
  }

  async connect(sessionConfig: ProviderSessionConfig): Promise<void> {
    this.ai = this.createClient(this.config.geminiApiKey);
    this.roomId = sessionConfig.roomId;
    this.sessionConfig = sessionConfig;

    this.session = await this.openLiveSession(sessionConfig);

    getLogger().info(
      { room_id: sessionConfig.roomId, provider: 'gemini' },
      'Sessão Gemini Live conectada',
    );
  }

  private async openLiveSession(sessionConfig: ProviderSessionConfig): Promise<LiveSession> {
    this.downlink.reset();
    const automaticActivityDetection = this.buildActivityDetection();
    const generation = ++this.sessionGeneration;

    return this.ai!.live.connect({
      model: this.config.geminiLiveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: sessionConfig.systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(sessionConfig.tools.length > 0
          ? {
              tools: [
                { functionDeclarations: toGeminiFunctionDeclarations(sessionConfig.tools) },
              ],
            }
          : {}),
        ...(automaticActivityDetection
          ? { realtimeInputConfig: { automaticActivityDetection } }
          : {}),
        // Sem limite explícito, o native-audio pensa antes de responder — e o
        // raciocínio inteiro acontece antes da tool call, dentro do atraso
        // percebido. `null` omite o campo (modelos sem thinking rejeitam a
        // sessão se ele estiver presente).
        ...(this.config.geminiThinkingBudget !== null
          ? { thinkingConfig: { thinkingBudget: this.config.geminiThinkingBudget } }
          : {}),
      },
      callbacks: {
        onmessage: (message) => {
          // Mesma guarda de `sessionGeneration` do onclose abaixo, mas para
          // áudio: `renewSession` só troca `this.session` e fecha a sessão
          // ANTIGA depois de `openLiveSession` (que já resetou `this.downlink`
          // para a sessão NOVA) resolver — nesse intervalo a sessão antiga
          // continua viva e sua `onmessage` está ligada a este mesmo closure.
          // Sem esta guarda, um `audio_response` tardio dela seria processado
          // pelo downlink já resetado (fase/histórico da sessão nova),
          // reintroduzindo a descontinuidade que ter estado existe para
          // eliminar — e não é só o resampler: duas sessões de modelo
          // diferentes não deveriam nunca alimentar o mesmo turno de qualquer
          // forma, já que o Orchestrator assume um único fluxo de fala ativo
          // por sala.
          if (generation !== this.sessionGeneration) return;
          this.handleMessage(message);
        },
        onerror: (e: { message?: string }) => {
          this.errorCb?.(new Error(e.message ?? 'Erro Gemini Live'));
        },
        // Fechamento abrupto sem `goAway` prévio (queda de rede do lado do
        // Gemini, por exemplo): sem isto a sala ficava com uma sessão morta
        // até o satélite cair — mesma lacuna que o `ws.on('close')` cobre no
        // OpenAIRealtimeAdapter.
        onclose: () => {
          if (this.disposed) return;
          // Sessão antiga fechada de propósito durante uma renovação: já foi
          // substituída em `this.session`, então este evento é tardio e não
          // deve mexer na sessão atual (ver comentário de `sessionGeneration`).
          if (generation !== this.sessionGeneration) return;
          getLogger().warn(
            { event: 'gemini_session_closed', room_id: this.roomId },
            'Sessão Gemini Live fechada pelo servidor sem goAway prévio',
          );
          this.notifySessionEnded();
        },
      },
    });
  }

  /**
   * O Live API fecha a sessão sozinho ao fim de um limite de duração e avisa
   * com `goAway` uns segundos antes. Sem isto, a sala fica com um provider
   * "vivo" na cara do RoomManager apontando pra uma sessão que o Gemini já
   * derrubou do lado dele — todo áudio depois disso cai num buraco negro, sem
   * erro nenhum, até o satélite desconectar.
   *
   * Só renova por baixo do pano se há conversa ativa (fala recente): é o caso
   * em que interromper seria perceptível. Ociosa, deixa morrer — recriar sob
   * demanda na próxima fala evita manter uma sessão Live (custo/cota de API)
   * rodando pra sempre enquanto o satélite só fica pingando em silêncio.
   */
  private handleGoAway(): void {
    if (this.disposed) return;

    const idleMs =
      this.lastAudioAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.lastAudioAt;

    if (idleMs < ACTIVE_CONVERSATION_WINDOW_MS) {
      void this.renewSession();
      return;
    }

    getLogger().info(
      { event: 'gemini_session_expired', room_id: this.roomId, idle_ms: idleMs },
      'Sessão Gemini Live ociosa: deixando expirar em vez de renovar',
    );
    this.session?.close();
    this.notifySessionEnded();
  }

  private async renewSession(): Promise<void> {
    if (this.reconnecting || this.disposed || !this.sessionConfig || !this.ai) return;
    this.reconnecting = true;

    const oldSession = this.session;
    try {
      // `this.sessionConfig.systemPrompt` está congelado no `connect()`
      // original — reusá-lo aqui prende "Agora são HH:MM" na hora em que a
      // sala foi criada, potencialmente horas atrás numa conversa ativa há
      // muito tempo (é exatamente o caso que justifica renovar em vez de
      // deixar expirar). Refaz o prompt com a hora de agora antes de reabrir.
      const refreshedConfig: ProviderSessionConfig = {
        ...this.sessionConfig,
        systemPrompt: this.sessionConfig.refreshSystemPrompt(),
      };
      this.sessionConfig = refreshedConfig;
      const newSession = await this.openLiveSession(refreshedConfig);
      this.session = newSession;
      oldSession?.close();
      getLogger().info(
        { event: 'gemini_session_renewed', room_id: this.roomId },
        'Sessão Gemini Live renovada antes do fechamento por goAway',
      );
    } catch (err) {
      getLogger().error(
        { event: 'gemini_session_renew_failed', room_id: this.roomId, err },
        'Falha ao renovar sessão Gemini Live antes do goAway',
      );
      this.errorCb?.(err instanceof Error ? err : new Error('Falha ao renovar sessão Gemini Live'));
      // A sessão antiga já estava a caminho do goAway e a nova falhou: sem
      // isto o provider ficava cacheado apontando pra uma sessão morta, e todo
      // áudio seguinte caía num buraco negro até o satélite desconectar. Fecha
      // explicitamente em vez de esperar o timeout do goAway do lado do Gemini.
      oldSession?.close();
      this.notifySessionEnded();
    } finally {
      this.reconnecting = false;
    }
  }

  sendAudio(pcm16kHz: Buffer): void {
    if (!this.session) {
      // Sessão morta (goAway ocioso, onclose, renovação que falhou) e o
      // satélite ainda mandando áudio: lançar aqui derrubava o processo
      // inteiro por unhandledRejection (handleAudioChunk é async e o
      // WsServer não tinha .catch). Descarta o chunk; a próxima fala recria
      // a sessão do zero via RoomManager.evictRoom, disparado por
      // notifySessionEnded logo abaixo.
      getLogger().warn(
        { event: 'gemini_send_audio_no_session', room_id: this.roomId },
        'Áudio recebido sem sessão Gemini Live ativa: descartado',
      );
      this.notifySessionEnded();
      return;
    }

    this.lastAudioAt = Date.now();

    // Sem VAD do servidor, o turno só abre se marcarmos o início explicitamente.
    if (this.config.geminiManualActivity && !this.activityOpen) {
      this.session.sendRealtimeInput({ activityStart: {} });
      this.activityOpen = true;
    }

    this.session.sendRealtimeInput({
      audio: {
        data: pcm16kHz.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
  }

  /**
   * Injeta um turno de **usuário** com a instrução e fecha o turno; a resposta
   * volta pelo caminho normal (`handleMessage` → `audioResponseCb`).
   *
   * Duas consequências que o chamador precisa conhecer: o modelo **parafraseia**
   * em vez de ler literal (é um turno de usuário, não um "diga isto"), e o
   * `turnComplete` correspondente chega com `userText` vazio — quem pediu a
   * fala tem que filtrar, senão o ring buffer da conversa se suja.
   *
   * Não mexe em `lastAudioAt` de propósito: pré-renderizar não deve manter uma
   * sessão paga viva contra o `goAway` por ociosidade.
   */
  async speak(instruction: string): Promise<boolean> {
    if (!this.session) return false;

    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: instruction }] }],
      turnComplete: true,
    });
    return true;
  }

  signalActivityEnd(): void {
    if (!this.session || !this.config.geminiManualActivity || !this.activityOpen) {
      return;
    }
    this.session.sendRealtimeInput({ activityEnd: {} });
    this.activityOpen = false;
  }

  onAudioResponse(callback: (chunk: Buffer) => void): void {
    this.audioResponseCb = callback;
  }

  onUserSpeech(callback: () => void): void {
    this.userSpeechCb = callback;
  }

  onTurnComplete(callback: (turn: CompletedTurn) => void): void {
    this.turnCompleteCb = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCb = callback;
  }

  onSessionEnded(callback: () => void): void {
    this.sessionEndedCb = callback;
  }

  onToolCall(callback: (call: ToolCall) => void): void {
    this.toolCallCb = callback;
  }

  sendToolResult(callId: string, result: unknown): void {
    const name = this.pendingToolCalls.get(callId);

    // Sem o `name` o SDK rejeita o functionResponse. Um callId desconhecido é
    // bug de correlação, mas lançar aqui derrubaria o turno inteiro do usuário.
    if (!this.session || !name) {
      getLogger().warn(
        { room_id: this.roomId, call_id: callId },
        'sendToolResult para callId desconhecido ou sessão fechada',
      );
      return;
    }

    this.pendingToolCalls.delete(callId);

    // A API exige um objeto JSON; primitivos vão sob a chave "output".
    const response =
      typeof result === 'object' && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { output: result };

    this.session.sendToolResponse({
      functionResponses: [{ id: callId, name, response }],
    });
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.pendingToolCalls.clear();
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }

  private handleMessage(message: {
    toolCall?: RawToolCall;
    goAway?: { timeLeft?: string };
    serverContent?: {
      inputTranscription?: { text?: string };
      outputTranscription?: { text?: string };
      modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
      turnComplete?: boolean;
      interrupted?: boolean;
      generationComplete?: boolean;
    };
  }): void {
    // Diagnóstico de sessão (foi assim que apareceu o `interrupted` do modo
    // manual). Expõe transcrição da fala do usuário no log — só em depuração.
    if (this.config.geminiDebugMessages) {
      getLogger().info(
        { raw: JSON.stringify(message).slice(0, 300) },
        'DEBUG mensagem Gemini',
      );
    }

    // Investigação da fala duplicada num único turno (ver commit da retry de
    // HA): se `interrupted`/`goAway`/`generationComplete` aparecerem perto de
    // um `outputTranscription` repetido, é o servidor do Gemini reiniciando a
    // geração, não um bug nosso de reenvio. Fica ligado sempre (barato,
    // dispara raro) até confirmarmos a causa.
    if (message.goAway) {
      getLogger().warn(
        { event: 'gemini_go_away', room_id: this.roomId, time_left: message.goAway.timeLeft },
        `Gemini avisou goAway (tempo restante: ${message.goAway.timeLeft ?? 'desconhecido'})`,
      );
      this.handleGoAway();
    }
    if (message.serverContent?.interrupted) {
      getLogger().warn(
        { event: 'gemini_interrupted', room_id: this.roomId },
        'Gemini reportou serverContent.interrupted',
      );
    }
    if (message.serverContent?.outputTranscription?.text) {
      getLogger().info(
        {
          event: 'assistant_transcript_delta',
          room_id: this.roomId,
          text: message.serverContent.outputTranscription.text,
          generation_complete: message.serverContent.generationComplete ?? null,
        },
        `Delta de transcrição da Luna: "${message.serverContent.outputTranscription.text}"`,
      );
    }

    // `toolCall` chega na raiz da mensagem, fora de `serverContent` — precisa
    // ser tratado antes do early return abaixo.
    if (message.toolCall) {
      for (const call of normalizeToolCalls(message.toolCall)) {
        this.pendingToolCalls.set(call.callId, call.name);
        getLogger().info(
          { event: 'tool_call', room_id: this.roomId, name: call.name, call_id: call.callId },
          `Tool call recebida: ${call.name}`,
        );
        this.toolCallCb?.(call);
      }
    }

    const serverContent = message.serverContent;

    if (!serverContent) return;

    if (serverContent.inputTranscription?.text) {
      this.userTranscript += serverContent.inputTranscription.text;
      this.userSpeechCb?.();
    }

    if (serverContent.outputTranscription?.text) {
      this.assistantTranscript += serverContent.outputTranscription.text;
    }

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data && this.audioResponseCb) {
        const pcm24k = Buffer.from(data, 'base64');
        const pcm16k = this.downlink.process(pcm24k);
        this.dump.write('24k-in', pcm24k);
        this.dump.write('16k-out', pcm16k);
        this.audioResponseCb(pcm16k);
      }
    }

    if (serverContent.turnComplete) {
      this.dump.endTurn();
      this.turnCompleteCb?.({
        userText: this.userTranscript.trim() || undefined,
        assistantText: this.assistantTranscript.trim() || undefined,
      });
      this.userTranscript = '';
      this.assistantTranscript = '';
    }
  }
}
