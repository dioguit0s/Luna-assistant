import type { RoomManager } from '../rooms/RoomManager.js';
import type { CompletedTurn } from '../providers/types.js';
import { CONTROL_DEVICE_TOOL } from '../providers/types.js';
import type { IAudioProvider } from '../providers/IAudioProvider.js';
import { createControlDeviceHandler } from './tools/controlDevice.js';
import { createSetReminderHandler } from './tools/setReminder.js';
import { INVALID_ARGS_RESULT, type ToolContext, type ToolHandler } from './tools/types.js';
import { CHIME_PCM16 } from '../reminders/chime.js';
import { SET_REMINDER_TOOL } from '../reminders/tools.js';
import type { ReminderStore } from '../reminders/ReminderStore.js';
import type { ReminderScheduler } from '../reminders/ReminderScheduler.js';
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

// Watchdog de `speaking_end`: se o áudio de resposta parar de chegar por esse
// tempo (turno perdido no provider, `onError` que não veio, conexão do
// provider caindo sem avisar), força o fim da fala em vez de deixar o
// satélite preso em RESPONDING. Abaixo do RESPONDING_TIMEOUT_MS do firmware
// (20s, luna-firmware/include/config.h) de propósito: o servidor precisa
// recuperar primeiro, e a rede de segurança do firmware fica reservada para
// quando o servidor também falha (crash, rede do satélite caindo).
export const SPEAKING_WATCHDOG_MS = 8_000;

// Taxa de saída de `audio_response`: os dois adapters (Gemini, OpenAI)
// reamostram para 16kHz PCM16 antes de chamar onAudioResponse — ver
// resample24kTo16k nos dois. É a mesma taxa do áudio de entrada
// (AUDIO_CHUNK_SIZE em protocol.ts), então o contrato é simétrico.
const AUDIO_RESPONSE_SAMPLE_RATE_HZ = 16_000;

// Frames pequenos: satélites embarcados (ESP32 / arduinoWebSockets) fecham a
// conexão ao receber um frame binário grande; o cliente de testes (Node)
// aceita qualquer tamanho.
export const MAX_AUDIO_FRAME_BYTES = 1024; // múltiplo de 2 (PCM16)

// Gemini/OpenAI entregam áudio muito mais rápido que tempo real — uma
// resposta de 30s cai inteira na socket em poucos segundos se despachada sem
// controle. Isso estoura o buffer de playback do firmware (512KB, ~16s —
// luna-firmware/include/config.h) e o excesso é *descartado* silenciosamente
// do lado de lá (xStreamBufferSend com timeout 0). Pacear a saída no ritmo em
// que o alto-falante realmente consome evita o descarte sem precisar de
// nenhuma sinalização adicional do firmware. O primeiro frame de cada
// resposta sai imediato (preserva o TTFAB); só os seguintes esperam este
// intervalo.
export const AUDIO_FRAME_INTERVAL_MS = Math.round(
  ((MAX_AUDIO_FRAME_BYTES / 2 / AUDIO_RESPONSE_SAMPLE_RATE_HZ) * 1000),
);

/**
 * Fan-out de um payload para todos os satélites de um cômodo. Devolve quantos
 * receberam de fato — 0 significa cômodo mudo (ninguém conectado).
 */
export type SendToRoom = (roomId: string, payload: Buffer | string) => number;

/** Item da fila por sala: um frame de áudio paceado, ou o speaking_end do turno. */
type AudioQueueItem =
  | { kind: 'audio'; header: Buffer; piece: Buffer }
  | { kind: 'speaking_end' };

export class Orchestrator {
  private readonly ttfabByRoom = new Map<string, TtfabTracker>();
  private readonly speakingByRoom = new Map<string, boolean>();
  // Debounce de "usuário parou de falar" (ver userSilenceCutoffMs): dispara
  // speaking_start antes do primeiro áudio de resposta, para o LED apagar
  // assim que o comando é capturado, não só quando a resposta começa a sair.
  private readonly silenceTimerByRoom = new Map<string, NodeJS.Timeout>();
  // Watchdog do SPEAKING_WATCHDOG_MS acima: rearmado a cada audio_response
  // (resposta longa não dispara), forçado quando o áudio para de chegar.
  private readonly speakingWatchdogByRoom = new Map<string, NodeJS.Timeout>();
  // Fila de envio por sala: frames de audio_response paceados no ritmo de
  // AUDIO_FRAME_INTERVAL_MS (evita estourar o buffer de playback do firmware
  // numa resposta longa) mais o próprio speaking_end enfileirado como último
  // item — nunca enviado direto por fora da fila, senão chegaria ANTES de
  // frames de áudio do mesmo turno ainda pendentes de pacing, uma condição de
  // corrida que faria a FSM do firmware sair de RESPONDING achando que a
  // resposta acabou com áudio dela ainda a caminho (ver drainAudioQueue).
  private readonly audioQueueByRoom = new Map<string, AudioQueueItem[]>();
  private readonly audioDrainTimerByRoom = new Map<string, NodeJS.Timeout>();
  // seq monotônico por sala: Date.now() repetia entre frames emitidos no
  // mesmo milissegundo, inutilizando o campo para ordenação/detecção de perda.
  private readonly audioSeqByRoom = new Map<string, number>();
  // Satélite que transmitiu por último em cada cômodo. Só para log: com o bind
  // dos callbacks na criação da sessão (RoomManager), não existe mais um
  // `deviceId` no escopo do bind — e nem sempre existe um, já que a sessão
  // pode nascer sem ninguém ter falado.
  private readonly lastDeviceIdByRoom = new Map<string, string>();
  /**
   * Último instante (epoch ms) em que sabemos que **o usuário ainda estava
   * falando** neste cômodo.
   *
   * A âncora NÃO pode ser "último chunk de áudio recebido", pelo mesmo motivo
   * que o `TtfabTracker` documenta: em open-mic o satélite transmite
   * continuamente (no firmware, `ACTIVE_STREAMING` é o estado permanente
   * quando a wake word não está disponível), então esse marco viraria sempre
   * "agora" e o guard de barge-in ficaria travado em "tem gente falando" — o
   * alarme nunca tocaria. O sinal certo é a transcrição de entrada do
   * provider, o mesmo que move a âncora do TTFAB.
   */
  private readonly lastUserSpeechAtByRoom = new Map<string, number>();
  /**
   * Registro de dispatch: nome da tool → handler. A chave casa o nome; validar
   * os args é obrigação do handler (ver `ToolHandler`). Nome fora do mapa é
   * tratado igual a args inválidos — do ponto de vista do modelo é a mesma
   * coisa, ele pediu algo que o servidor não sabe executar.
   */
  private readonly toolHandlers: Map<string, ToolHandler>;
  /**
   * Late-bound: no boot, o `ReminderScheduler` só existe depois que o
   * `WsServer` (e o Orchestrator dentro dele) já subiu — o scheduler precisa
   * do `ringOnce` do Orchestrator para disparar, e o Orchestrator precisa do
   * scheduler para o handler de `set_reminder` chamar `reschedule()`. Ver
   * `setReminderScheduler`.
   */
  private reminderScheduler: ReminderScheduler | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly roomManager: RoomManager,
    haClient: HomeAssistantClient,
    deviceRegistry: DeviceRegistrySource,
    /**
     * Endereçamento por cômodo, resolvido pelo `WsServer` no momento do envio.
     * O Orchestrator não guarda conexão nenhuma: o provider é cacheado por
     * cômodo e sobrevive à reconexão do satélite, a conexão WS não. Guardar
     * um `sendToClient` aqui prendia a resposta na conexão que existia quando
     * o provider foi criado — e, com um `sendToClient` por cômodo, no ÚLTIMO
     * satélite que falou: os outros da mesma sala ficavam sem `speaking_start`
     * e sem áudio, e um satélite ocioso (que só acorda por wake word e nunca
     * transmitiu nada) era inalcançável.
     */
    private readonly sendToRoom: SendToRoom,
    reminderStore: ReminderStore,
  ) {
    this.toolHandlers = new Map<string, ToolHandler>([
      [
        CONTROL_DEVICE_TOOL.name,
        createControlDeviceHandler({
          haClient,
          deviceRegistry,
          sendToRoom: (targetRoom, payload) => this.sendToRoom(targetRoom, payload),
        }),
      ],
      [
        SET_REMINDER_TOOL.name,
        createSetReminderHandler({
          store: reminderStore,
          getScheduler: () => {
            if (!this.reminderScheduler) {
              // Só aconteceria se o boot estivesse fora de ordem
              // (`setReminderScheduler` chamado depois de o modelo já poder
              // falar) — um bug de wiring, não uma entrada de usuário.
              throw new Error('ReminderScheduler ainda não registrado no Orchestrator');
            }
            return this.reminderScheduler;
          },
          reminderMaxPerRoom: config.reminderMaxPerRoom,
        }),
      ],
    ]);

    // O bind dos callbacks passa a acontecer na criação da sessão, não no
    // primeiro chunk de áudio: um provider criado por qualquer outro caminho
    // — o disparo de alarme, que fala sem ter sido perguntado — nasceria sem
    // `onAudioResponse` e a fala cairia no vazio, sem erro nenhum.
    roomManager.setProviderBinder((roomId, provider) =>
      this.bindProviderCallbacks(roomId, provider),
    );
  }

  /**
   * Chamado por `index.ts` depois que o `WsServer` (e este Orchestrator)
   * sobem: o `ReminderScheduler` é criado depois porque o `onFire` dele
   * precisa do `ringOnce` deste Orchestrator, e o Orchestrator precisa do
   * scheduler para o handler de `set_reminder` chamar `reschedule()` —
   * nenhum dos dois pode nascer primeiro sem esta injeção tardia.
   */
  setReminderScheduler(scheduler: ReminderScheduler): void {
    this.reminderScheduler = scheduler;
  }

  async handleAudioChunk(roomId: string, deviceId: string, pcm: Buffer): Promise<void> {
    const tracker = this.getTtfabTracker(roomId);
    tracker.markClientAudioReceived();

    this.lastDeviceIdByRoom.set(roomId, deviceId);
    this.roomManager.getRingBuffer().touch(roomId);

    // Os callbacks já vêm registrados de `RoomManager.createProviderSession`.
    const provider = await this.roomManager.getOrCreateProvider(roomId);

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

  /**
   * Registra os callbacks do port num provider recém-criado. Chamado por
   * `RoomManager.createProviderSession` (ver o binder no construtor), uma vez
   * por provider; a WeakSet é a garantia de que continua sendo uma só, mesmo
   * se um caminho novo chamar de novo — dois binds no mesmo provider dobrariam
   * cada `speaking_start` e cada frame de áudio.
   */
  private bindProviderCallbacks(roomId: string, provider: IAudioProvider): void {
    if (this.boundProviders.has(provider)) return;
    this.boundProviders.add(provider);

    // Resolvido a cada log, nunca capturado: o bind acontece na criação da
    // sessão, quando pode não haver satélite nenhum tendo falado ainda.
    const deviceId = (): string | null => this.lastDeviceIdByRoom.get(roomId) ?? null;

    const tracker = this.getTtfabTracker(roomId);
    const providerName = getActiveProviderName(this.config);

    provider.onUserSpeech(() => {
      tracker.markUserSpeech();
      this.lastUserSpeechAtByRoom.set(roomId, Date.now());

      // Reagenda a cada fragmento: só assume "parou de falar" depois de
      // silêncio sustentado. No Gemini isso dispara a cada pedaço de
      // transcrição (ainda falando); no OpenAI é um único evento discreto
      // (fala já parou), então o timer só soma um atraso fixo pequeno.
      this.clearSilenceTimer(roomId);
      this.silenceTimerByRoom.set(
        roomId,
        setTimeout(() => {
          this.silenceTimerByRoom.delete(roomId);
          this.startSpeaking(roomId);
        }, this.config.userSilenceCutoffMs),
      );
    });

    provider.onAudioResponse((chunk) => {
      const latencyMs = tracker.markFirstResponseSent();
      if (latencyMs !== null) {
        getLogger().info(
          {
            event: 'ttfab',
            room_id: roomId,
            device_id: deviceId(),
            provider: providerName,
            latency_ms: latencyMs,
          },
          `TTFAB: ${latencyMs}ms`,
        );
      }

      // Áudio já chegou: o corte por silêncio, se ainda pendente, perdeu a
      // corrida — cancela para não disparar um speaking_start supérfluo
      // (já sem efeito, guardado por speakingByRoom) depois do turno seguir.
      this.clearSilenceTimer(roomId);
      this.startSpeaking(roomId);
      // Rearma mesmo quando startSpeaking() foi no-op (já estava falando):
      // é o áudio fluindo que prova que o turno segue vivo, não o envio do
      // speaking_start (que só acontece uma vez). Sem isto, uma resposta
      // longa acionaria o watchdog no meio dela mesma.
      this.armSpeakingWatchdog(roomId);

      // Fragmenta e enfileira — não envia direto: ver AUDIO_FRAME_INTERVAL_MS.
      this.enqueueAudioFrames(roomId, chunk);
    });

    provider.onTurnComplete((turn: CompletedTurn) => {
      // Turno fechou (ex.: tool call sem confirmação falada): sem isso, um
      // debounce ainda pendente dispararia speaking_start depois do turno já
      // ter acabado, sem speaking_end correspondente no rastro — a luz
      // apagaria e não voltaria a acender sozinha.
      this.clearSilenceTimer(roomId);

      // Sem isto não dá pra distinguir, pelo log, um comando que gerou UM
      // turno (fala + tool call juntos) de dois turnos separados (ex.: fala
      // parcial antes do resultado da tool chegar, seguida de um segundo
      // turno com a confirmação) — o segundo caso soa como a resposta
      // tocando duas vezes no satélite.
      getLogger().info(
        {
          event: 'turn_complete',
          room_id: roomId,
          device_id: deviceId(),
          had_audio: this.speakingByRoom.get(roomId) === true,
          assistant_text: turn.assistantText ?? null,
        },
        `Turno concluído${turn.assistantText ? `: "${turn.assistantText}"` : ' (sem fala)'}`,
      );

      if (turn.userText || turn.assistantText) {
        this.roomManager
          .getRingBuffer()
          .appendTurn(roomId, turn.userText ?? '', turn.assistantText ?? '');
      }

      this.endSpeaking(roomId);

      tracker.reset();
    });

    provider.onToolCall((call) => {
      // Fronteira de confiança: `name` e `args` são texto gerado pelo modelo.
      // O registro casa o nome; o handler valida o conteúdo.
      const handler = this.toolHandlers.get(call.name);
      if (!handler) {
        getLogger().error(
          { event: 'tool_call', room_id: roomId, name: call.name, args: call.args },
          'Tool call inválida ou desconhecida',
        );
        provider.sendToolResult(call.callId, INVALID_ARGS_RESULT);
        return;
      }

      const ctx: ToolContext = {
        roomId,
        deviceId: deviceId(),
        provider,
        callId: call.callId,
        // Latência do modelo: fim da fala → decisão de chamar a tool. É o termo
        // dominante do atraso percebido; o despacho no HA fica na casa dos 15ms.
        modelDecisionMs: tracker.elapsedSinceAnchor(),
      };

      // O callback do port é síncrono e o handler é async, então isto não pode
      // ficar como promise solta. O `.catch` é o andaime que nenhuma tool
      // precisa repetir: sem ele, a rejeição derrubava o processo inteiro (era
      // o mesmo `void` "confiável" que já tinha sido a causa da queda por HA
      // fora do ar) e o modelo nunca recebia o `functionResponse` — o turno do
      // usuário ficava pendurado para sempre esperando a Luna falar.
      void handler(call.args, ctx)
        .then((result) => {
          provider.sendToolResult(call.callId, result);
        })
        .catch((err: unknown) => {
          getLogger().error(
            {
              event: 'tool_dispatch_failed',
              room_id: roomId,
              device_id: ctx.deviceId,
              name: call.name,
              err: err instanceof Error ? err.message : String(err),
            },
            `Falha ao concluir a tool ${call.name}`,
          );
          try {
            provider.sendToolResult(call.callId, {
              success: false,
              error: 'falha ao executar o comando',
            });
          } catch {
            // Provider também fora do ar (mesma causa raiz): nada mais a
            // fazer, o turno será recriado do zero na próxima fala.
          }
        });
    });

    provider.onError((err) => {
      getLogger().error(
        {
          room_id: roomId,
          device_id: deviceId(),
          provider: providerName,
          err: err.message,
        },
        'Erro no provider de áudio',
      );
      // Sem isto, um erro no meio de uma resposta em voo deixava o satélite
      // preso em RESPONDING (TX suspenso, wake word desligada) até o teto de
      // 20s do firmware — `onError` sozinho nunca fechava o par
      // speaking_start/speaking_end.
      this.endSpeaking(roomId);
    });

    // Sessão morreu de ociosidade (ver GeminiLiveAdapter.handleGoAway) ou o
    // socket caiu sozinho (ver `onclose`/`ws.on('close')` dos dois adapters):
    // descarta o provider cacheado. O satélite continua conectado (senão seria
    // `unregisterClient`), então sem isto a sala ficaria presa com um provider
    // morto até o próximo reboot/queda do dispositivo.
    provider.onSessionEnded(() => {
      // Idem onError: se a sessão morreu no meio de uma resposta, o par
      // speaking_start/speaking_end nunca fecharia sozinho.
      this.endSpeaking(roomId);
      // Estado por sala do Orchestrator (timers, watchdog, tracker de TTFAB):
      // a próxima fala recria tudo do zero via bindProviderCallbacksOnce no
      // provider novo. O endereçamento não está aqui — quem sabe quais
      // satélites existem no cômodo é o `WsServer`, e ele não perde nada
      // quando a sessão do provider morre.
      this.releaseRoom(roomId);
      this.roomManager.evictRoom(roomId);
    });
  }

  /**
   * Libera o estado por sala que o Orchestrator mantém fora do RoomManager
   * (TTFAB, flag de fala, debounce de silêncio, watchdog de speaking_end,
   * fila de envio). Sem isto: um timer de silêncio pendente
   * dispara depois do satélite ter ido embora, mandando `speaking_start`
   * para um cômodo vazio; e, pior, `speakingByRoom` preso em `true` faz a *próxima*
   * sessão daquela sala nunca mandar `speaking_start` (`startSpeaking()`
   * checa a flag e retorna cedo) — um bug de estado atravessando sessões.
   *
  /**
   * Métodos de fala por cômodo: `startSpeaking`/`endSpeaking` e o timer de
   * silêncio/watchdog que os cercam.
   *
   * Extraídos do closure de `bindProviderCallbacks` de propósito: os mapas
   * que guardam o estado (`speakingByRoom`, `speakingWatchdogByRoom`,
   * `silenceTimerByRoom`) já são de classe, chaveados por `roomId` — a única
   * coisa que os prendia ao closure de um provider era a conveniência de não
   * repassar `roomId`. Presos lá, só quem tem uma sessão de provider viva
   * conseguiria mandar `speaking_start`/`speaking_end` — e o chime (`ringOnce`,
   * abaixo) não tem provider nenhum: é PCM puro pela fila existente.
   */

  private clearSilenceTimer(roomId: string): void {
    const timer = this.silenceTimerByRoom.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimerByRoom.delete(roomId);
    }
  }

  private clearSpeakingWatchdog(roomId: string): void {
    const timer = this.speakingWatchdogByRoom.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.speakingWatchdogByRoom.delete(roomId);
    }
  }

  /**
   * Rearmado a cada chunk de áudio de resposta (ver `onAudioResponse`): só
   * dispara quando o áudio *para* de chegar, então uma resposta longa nunca
   * aciona o watchdog sozinha. Um `ringOnce` também arma e imediatamente
   * limpa: como o chime tem duração conhecida e `endSpeaking` é chamado logo
   * depois de enfileirar, o watchdog nunca chega a disparar para ele.
   *
   * **Não** rearmar no enfileiramento (`enqueueAudioFrames`), por mais que
   * pareça o ponto natural: o que este watchdog mede é *liveness do provider*,
   * não estado de fila. Um provider que morresse depois de despejar 20 s de
   * áudio na fila manteria o watchdog vivo por esses 20 s, e a única rede de
   * segurança abaixo do `RESPONDING_TIMEOUT_MS` de 20 s do firmware sumiria
   * justamente no caso para o qual ela existe. O ciclo de toque não precisa
   * disso: cada rajada tem duração conhecida e fecha o par sincronicamente —
   * há teste que trava esse invariante.
   */
  private armSpeakingWatchdog(roomId: string): void {
    this.clearSpeakingWatchdog(roomId);
    this.speakingWatchdogByRoom.set(
      roomId,
      setTimeout(() => {
        this.speakingWatchdogByRoom.delete(roomId);
        getLogger().warn(
          { event: 'speaking_watchdog', room_id: roomId, timeout_ms: SPEAKING_WATCHDOG_MS },
          `Sem áudio de resposta há ${SPEAKING_WATCHDOG_MS}ms: forçando speaking_end`,
        );
        this.endSpeaking(roomId);
      }, SPEAKING_WATCHDOG_MS),
    );
  }

  /**
   * Único ponto que efetivamente manda `speaking_start`: o debounce de
   * silêncio, o primeiro áudio de resposta do provider e `ringOnce` passam
   * todos por aqui, com a flag `speakingByRoom` evitando o envio duplicado —
   * o mais rápido dos três vence.
   *
   * Devolve quantos satélites do cômodo receberam de fato (mesmo contrato de
   * `SendToRoom`) — 0 tanto para "sala vazia" quanto para "já estava
   * falando" (no-op). Só `ringOnce` usa o valor; os outros chamadores
   * ignoram.
   */
  private startSpeaking(roomId: string): number {
    if (this.speakingByRoom.get(roomId)) return 0;
    this.speakingByRoom.set(roomId, true);
    // Endereça o cômodo, não uma conexão: o conjunto de satélites da sala
    // muda embaixo (reconexão, segundo satélite entrando). Quem resolve é o
    // `WsServer`.
    const delivered = this.sendToRoom(
      roomId,
      serializeControlMessage(createEnvelope('speaking_start', roomId)),
    );
    this.armSpeakingWatchdog(roomId);
    return delivered;
  }

  /**
   * Espelho de `startSpeaking`. Único ponto que efetivamente manda
   * `speaking_end` — turno concluído, erro do provider, sessão encerrada,
   * watchdog de silêncio ou fim de um `ringOnce`, todos passam por aqui, com a
   * mesma flag evitando o envio duplicado. Enfileirado, não enviado direto: se
   * ainda houver frame de áudio pendente de pacing, `speaking_end` precisa
   * sair DEPOIS dele, nunca antes (ver comentário de `audioQueueByRoom`).
   */
  private endSpeaking(roomId: string): void {
    this.clearSpeakingWatchdog(roomId);
    if (!this.speakingByRoom.get(roomId)) return;
    this.speakingByRoom.set(roomId, false);
    this.enqueueSend(roomId, { kind: 'speaking_end' });
  }

  /**
   * Toca o chime uma vez no cômodo: `speaking_start` → o PCM fragmentado pela
   * mesma fila paceada do `audio_response` → `speaking_end`. Nenhum provider
   * envolvido — é a rota que o marco 6 (`set_reminder`) e o marco 7
   * (`AlarmRinger`) vão chamar quando um lembrete vence, sessão de IA viva ou
   * não.
   *
   * Devolve quantos satélites do cômodo receberam o `speaking_start`: 0 é o
   * sinal de "sala muda" que o fallback de sala offline (marco 6) vai
   * precisar.
   *
   * Um turno de verdade já em progresso na sala (`speakingByRoom` true — o
   * provider está no meio de uma resposta) também devolve 0, sem enfileirar
   * nada: empurrar o chime por cima truncaria a fala em andamento, que é pior
   * que não tocar. A guarda completa contra interromper a fala do *usuário*
   * (`lastAudioAtByRoom`, decisão 9 do plano) é do marco 7 — esta aqui é só o
   * caso mais óbvio, checável com o estado que já existe.
   */
  ringOnce(roomId: string): number {
    if (this.speakingByRoom.get(roomId)) return 0;
    // O usuário está no meio de uma frase: `speaking_start` faria o firmware
    // dar `xQueueReset(txQueue)` e o provider receberia meio comando. Vale
    // tanto para a primeira rajada quanto para a corrida na borda das
    // seguintes — a wake word da dispensa caindo no instante do re-disparo.
    if (this.isUserLikelySpeaking(roomId)) return 0;

    const delivered = this.startSpeaking(roomId);
    this.enqueueAudioFrames(roomId, CHIME_PCM16);
    this.endSpeaking(roomId);
    return delivered;
  }

  /**
   * Há quanto tempo o usuário falou nesta sala, em ms — `null` quando não há
   * fala conhecida (sala ociosa, ou sessão recém-criada pelo caminho do
   * alarme). Quem toca alarme usa isto para distinguir "não entreguei porque
   * a sala está vazia" de "não entreguei porque tem gente falando".
   */
  msSinceUserSpeech(roomId: string): number | null {
    const at = this.lastUserSpeechAtByRoom.get(roomId);
    return at === undefined ? null : Date.now() - at;
  }

  /** Guard de barge-in: fala do usuário recente o bastante para não ser cortada. */
  isUserLikelySpeaking(roomId: string): boolean {
    const since = this.msSinceUserSpeech(roomId);
    return since !== null && since < this.config.ringBargeInGuardMs;
  }

  /**
   * Chamado em dois pontos: quando o último cliente WS da sala desconecta
   * (`WsServer.handleDisconnect`, via `RoomManager.unregisterClient`) e
   * quando o provider encerra a sessão sozinho (`onSessionEnded` acima) — os
   * dois marcam o fim de vida de "alguém ainda pode estar ouvindo esta sala".
   */
  releaseRoom(roomId: string): void {
    this.ttfabByRoom.delete(roomId);
    this.speakingByRoom.delete(roomId);
    this.lastDeviceIdByRoom.delete(roomId);
    this.lastUserSpeechAtByRoom.delete(roomId);

    const silenceTimer = this.silenceTimerByRoom.get(roomId);
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      this.silenceTimerByRoom.delete(roomId);
    }

    const watchdog = this.speakingWatchdogByRoom.get(roomId);
    if (watchdog) {
      clearTimeout(watchdog);
      this.speakingWatchdogByRoom.delete(roomId);
    }

    // Áudio de um turno morto não pode vazar para a conexão/sessão seguinte
    // da mesma sala.
    this.audioQueueByRoom.delete(roomId);
    const drainTimer = this.audioDrainTimerByRoom.get(roomId);
    if (drainTimer) {
      clearTimeout(drainTimer);
      this.audioDrainTimerByRoom.delete(roomId);
    }
    this.audioSeqByRoom.delete(roomId);
  }

  private nextAudioSeq(roomId: string): number {
    const seq = (this.audioSeqByRoom.get(roomId) ?? 0) + 1;
    this.audioSeqByRoom.set(roomId, seq);
    return seq;
  }

  /**
   * Fragmenta `chunk` em frames de `MAX_AUDIO_FRAME_BYTES` e enfileira todos
   * de uma vez, como um único lote — ver `enqueueSends` para o porquê de não
   * enfileirar frame a frame.
   */
  private enqueueAudioFrames(roomId: string, chunk: Buffer): void {
    const items: AudioQueueItem[] = [];
    for (let offset = 0; offset < chunk.length; offset += MAX_AUDIO_FRAME_BYTES) {
      const piece = chunk.subarray(offset, offset + MAX_AUDIO_FRAME_BYTES);
      const header = Buffer.from(
        serializeControlMessage(
          createEnvelope('audio_response', roomId, { seq: this.nextAudioSeq(roomId) }),
        ),
        'utf8',
      );
      items.push({ kind: 'audio', header, piece });
    }
    this.enqueueSends(roomId, items);
  }

  /** Enfileira um único item (ex.: speaking_end) — açúcar sobre `enqueueSends`. */
  private enqueueSend(roomId: string, item: AudioQueueItem): void {
    this.enqueueSends(roomId, [item]);
  }

  /**
   * Enfileira um lote de itens de envio da sala. Se a fila estava vazia
   * (nenhum drain em andamento), dispara o primeiro item do lote já — na
   * mesma call stack, sem esperar o intervalo — para não empurrar latência
   * para dentro do TTFAB nem atrasar um speaking_end que chega com a fila já
   * vazia (caso comum).
   *
   * Precisa ser um lote, não um item por chamada: `drainAudioQueue` limpa
   * `audioDrainTimerByRoom` na hora quando a fila esvazia (para não atrasar
   * o próximo `enqueueSend`, como o `speaking_end` de `endSpeaking`, atrás de
   * um tick fantasma). Enfileirar frame a frame reabriria a janela "fila
   * vazia" entre um frame e o próximo dentro do MESMO chunk, e cada um
   * disparia `drainAudioQueue` de novo, sincronamente — a fragmentação
   * inteira sairia de uma vez, sem pacing nenhum.
   */
  private enqueueSends(roomId: string, items: AudioQueueItem[]): void {
    if (items.length === 0) return;

    let queue = this.audioQueueByRoom.get(roomId);
    if (!queue) {
      queue = [];
      this.audioQueueByRoom.set(roomId, queue);
    }
    const wasIdle = queue.length === 0 && !this.audioDrainTimerByRoom.has(roomId);

    queue.push(...items);

    if (wasIdle) {
      this.drainAudioQueue(roomId);
    }
  }

  /**
   * Envia um item da fila da sala e reagenda a si mesma para o próximo. Itens
   * de áudio são espaçados por AUDIO_FRAME_INTERVAL_MS — o ritmo em que o
   * alto-falante do satélite realmente consome o áudio; speaking_end não tem
   * conteúdo a pacear e sai assim que chega a vez dele na fila.
   * O destino é resolvido aqui dentro, a cada item — nunca capturado no
   * enfileiramento: entre o primeiro frame e o último de uma resposta longa o
   * satélite pode reconectar, ou um segundo satélite pode entrar no cômodo.
   */
  private drainAudioQueue(roomId: string): void {
    const queue = this.audioQueueByRoom.get(roomId);
    if (!queue || queue.length === 0) {
      this.audioQueueByRoom.delete(roomId);
      this.audioDrainTimerByRoom.delete(roomId);
      return;
    }

    const item = queue.shift()!;
    if (item.kind === 'audio') {
      this.sendToRoom(roomId, Buffer.concat([item.header, item.piece]));
    } else {
      this.sendToRoom(roomId, serializeControlMessage(createEnvelope('speaking_end', roomId)));
    }

    if (queue.length === 0) {
      // Nada mais na fila: limpa já em vez de agendar mais um tick só para
      // descobrir isto depois. Sem isto, `audioDrainTimerByRoom` continuaria
      // "ocupado" por mais um ciclo — um `endSpeaking()` chamado logo em
      // seguida (onError, onSessionEnded) veria `wasIdle = false` em
      // `enqueueSend` e esperaria esse tick fantasma antes de mandar
      // speaking_end, atrasando a recuperação à toa.
      this.audioQueueByRoom.delete(roomId);
      this.audioDrainTimerByRoom.delete(roomId);
      return;
    }

    // O atraso vale para o PRÓXIMO envio, então depende do tipo do PRÓXIMO
    // item (queue[0] agora), não do que acabou de sair: um speaking_end
    // enfileirado atrás de áudio não carrega bytes nenhum disputando o buffer
    // de playback do firmware — atrasá-lo por AUDIO_FRAME_INTERVAL_MS só
    // adiaria a notificação de "resposta acabou" sem nenhum ganho de pacing.
    const nextDelayMs = queue[0]!.kind === 'audio' ? AUDIO_FRAME_INTERVAL_MS : 0;
    this.audioDrainTimerByRoom.set(
      roomId,
      setTimeout(() => this.drainAudioQueue(roomId), nextDelayMs),
    );
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
