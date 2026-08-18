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

    const clearSilenceTimer = (): void => {
      const timer = this.silenceTimerByRoom.get(roomId);
      if (timer) {
        clearTimeout(timer);
        this.silenceTimerByRoom.delete(roomId);
      }
    };

    const clearSpeakingWatchdog = (): void => {
      const timer = this.speakingWatchdogByRoom.get(roomId);
      if (timer) {
        clearTimeout(timer);
        this.speakingWatchdogByRoom.delete(roomId);
      }
    };

    // Rearmado a cada chunk de áudio de resposta (ver onAudioResponse): só
    // dispara quando o áudio *para* de chegar, então uma resposta longa nunca
    // aciona o watchdog sozinha.
    const armSpeakingWatchdog = (): void => {
      clearSpeakingWatchdog();
      this.speakingWatchdogByRoom.set(
        roomId,
        setTimeout(() => {
          this.speakingWatchdogByRoom.delete(roomId);
          getLogger().warn(
            { event: 'speaking_watchdog', room_id: roomId, timeout_ms: SPEAKING_WATCHDOG_MS },
            `Sem áudio de resposta há ${SPEAKING_WATCHDOG_MS}ms: forçando speaking_end`,
          );
          endSpeaking();
        }, SPEAKING_WATCHDOG_MS),
      );
    };

    // Único ponto que efetivamente manda speaking_start: tanto o debounce de
    // silêncio quanto o primeiro áudio de resposta passam por aqui, com a
    // flag `speakingByRoom` evitando o envio duplicado — o mais rápido dos
    // dois vence.
    const startSpeaking = (): void => {
      if (this.speakingByRoom.get(roomId)) return;
      this.speakingByRoom.set(roomId, true);
      sendToClient(serializeControlMessage(createEnvelope('speaking_start', roomId)));
      armSpeakingWatchdog();
    };

    // Espelho de startSpeaking. Único ponto que efetivamente manda
    // speaking_end — turno concluído, erro do provider, sessão encerrada ou
    // watchdog de silêncio, todos passam por aqui, com a mesma flag evitando
    // o envio duplicado. Enfileirado, não enviado direto: se ainda houver
    // frame de áudio deste turno pendente de pacing, speaking_end precisa
    // sair DEPOIS dele, nunca antes (ver comentário de audioQueueByRoom).
    const endSpeaking = (): void => {
      clearSpeakingWatchdog();
      if (!this.speakingByRoom.get(roomId)) return;
      this.speakingByRoom.set(roomId, false);
      this.enqueueSend(roomId, { kind: 'speaking_end' });
    };

    provider.onUserSpeech(() => {
      tracker.markUserSpeech();

      // Reagenda a cada fragmento: só assume "parou de falar" depois de
      // silêncio sustentado. No Gemini isso dispara a cada pedaço de
      // transcrição (ainda falando); no OpenAI é um único evento discreto
      // (fala já parou), então o timer só soma um atraso fixo pequeno.
      clearSilenceTimer();
      this.silenceTimerByRoom.set(
        roomId,
        setTimeout(() => {
          this.silenceTimerByRoom.delete(roomId);
          startSpeaking();
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
            device_id: deviceId,
            provider: providerName,
            latency_ms: latencyMs,
          },
          `TTFAB: ${latencyMs}ms`,
        );
      }

      // Áudio já chegou: o corte por silêncio, se ainda pendente, perdeu a
      // corrida — cancela para não disparar um speaking_start supérfluo
      // (já sem efeito, guardado por speakingByRoom) depois do turno seguir.
      clearSilenceTimer();
      startSpeaking();
      // Rearma mesmo quando startSpeaking() foi no-op (já estava falando):
      // é o áudio fluindo que prova que o turno segue vivo, não o envio do
      // speaking_start (que só acontece uma vez). Sem isto, uma resposta
      // longa acionaria o watchdog no meio dela mesma.
      armSpeakingWatchdog();

      // Fragmenta e enfileira — não envia direto: ver AUDIO_FRAME_INTERVAL_MS.
      this.enqueueAudioFrames(roomId, chunk);
    });

    provider.onTurnComplete((turn: CompletedTurn) => {
      // Turno fechou (ex.: tool call sem confirmação falada): sem isso, um
      // debounce ainda pendente dispararia speaking_start depois do turno já
      // ter acabado, sem speaking_end correspondente no rastro — a luz
      // apagaria e não voltaria a acender sozinha.
      clearSilenceTimer();

      // Sem isto não dá pra distinguir, pelo log, um comando que gerou UM
      // turno (fala + tool call juntos) de dois turnos separados (ex.: fala
      // parcial antes do resultado da tool chegar, seguida de um segundo
      // turno com a confirmação) — o segundo caso soa como a resposta
      // tocando duas vezes no satélite.
      getLogger().info(
        {
          event: 'turn_complete',
          room_id: roomId,
          device_id: deviceId,
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

      endSpeaking();

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

      // O callback do port é síncrono; a chamada ao HA é async, então isto
      // não pode ficar como promise solta.
      //
      // O `sendToolResult` espera o HA de propósito: com a verificação de
      // estado fora do caminho crítico, o await custa só o POST (~20-40ms) e
      // preserva o único sinal de falha verdadeiro (HA fora do ar, 401,
      // timeout). Responder otimista antes do POST faria a Luna confirmar em
      // voz um comando que falhou de fato.
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
        })
        .catch((err: unknown) => {
          // `callService` em si nunca lança (contrato do HomeAssistantClient),
          // mas este `.then` chama `sendToClient` (socket morto) e
          // `provider.sendToolResult` (ex.: `session.sendToolResponse` do
          // Gemini numa sessão já fechada) — os dois podem lançar. Sem este
          // `.catch`, a rejeição derrubava o processo inteiro (era o mesmo
          // `void` "confiável" que já tinha sido a causa da queda por HA fora
          // do ar) e o modelo nunca recebia o `functionResponse`: o turno do
          // usuário ficava pendurado para sempre esperando a Luna falar.
          getLogger().error(
            {
              event: 'command_dispatch_failed',
              room_id: roomId,
              device_id: deviceId,
              device,
              action,
              entity_id: entityId,
              err: err instanceof Error ? err.message : String(err),
            },
            `Falha ao concluir o despacho de ${device} → ${action}`,
          );
          try {
            provider.sendToolResult(call.callId, {
              success: false,
              error: 'falha ao acionar o dispositivo',
            });
          } catch {
            // Provider também fora do ar (mesma causa raiz): nada mais a
            // fazer, o turno será recriado do zero na próxima fala.
          }
        });
    });

    provider.onError((err) => {
      getLogger().error(
        { room_id: roomId, device_id: deviceId, provider: providerName, err: err.message },
        'Erro no provider de áudio',
      );
      // Sem isto, um erro no meio de uma resposta em voo deixava o satélite
      // preso em RESPONDING (TX suspenso, wake word desligada) até o teto de
      // 20s do firmware — `onError` sozinho nunca fechava o par
      // speaking_start/speaking_end.
      endSpeaking();
    });

    // Sessão morreu de ociosidade (ver GeminiLiveAdapter.handleGoAway) ou o
    // socket caiu sozinho (ver `onclose`/`ws.on('close')` dos dois adapters):
    // descarta o provider cacheado. O satélite continua conectado (senão seria
    // `unregisterClient`), então sem isto a sala ficaria presa com um provider
    // morto até o próximo reboot/queda do dispositivo.
    provider.onSessionEnded(() => {
      // Idem onError: se a sessão morreu no meio de uma resposta, o par
      // speaking_start/speaking_end nunca fecharia sozinho.
      endSpeaking();
      // Estado por sala do Orchestrator (timers, watchdog, tracker de TTFAB):
      // a próxima fala recria tudo do zero via bindProviderCallbacksOnce no
      // provider novo. sendToClientByRoom especificamente é reposto no
      // primeiro handleAudioChunk seguinte, então apagar aqui não perde nada
      // — só evita que fique presa em `true` (bug de estado atravessando
      // sessões: ver releaseRoom).
      this.releaseRoom(roomId);
      this.roomManager.evictRoom(roomId);
    });
  }

  /**
   * Libera o estado por sala que o Orchestrator mantém fora do RoomManager
   * (TTFAB, flag de fala, debounce de silêncio, watchdog de speaking_end,
   * `sendToClient` da conexão atual). Sem isto: um timer de silêncio pendente
   * dispara depois do satélite ter ido embora, chamando `sendToClient` numa
   * conexão morta; e, pior, `speakingByRoom` preso em `true` faz a *próxima*
   * sessão daquela sala nunca mandar `speaking_start` (`startSpeaking()`
   * checa a flag e retorna cedo) — um bug de estado atravessando sessões.
   *
   * Chamado em dois pontos: quando o último cliente WS da sala desconecta
   * (`WsServer.handleDisconnect`, via `RoomManager.unregisterClient`) e
   * quando o provider encerra a sessão sozinho (`onSessionEnded` acima) — os
   * dois marcam o fim de vida de "alguém ainda pode estar ouvindo esta sala".
   */
  releaseRoom(roomId: string): void {
    this.ttfabByRoom.delete(roomId);
    this.speakingByRoom.delete(roomId);
    this.sendToClientByRoom.delete(roomId);

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
   * `sendToClientByRoom` é resolvido aqui dentro (não capturado), pela mesma
   * razão do `sendToClient` em `bindProviderCallbacksOnce`: sobreviver a uma
   * reconexão do satélite no meio de uma resposta longa.
   */
  private drainAudioQueue(roomId: string): void {
    const queue = this.audioQueueByRoom.get(roomId);
    if (!queue || queue.length === 0) {
      this.audioQueueByRoom.delete(roomId);
      this.audioDrainTimerByRoom.delete(roomId);
      return;
    }

    const item = queue.shift()!;
    const sendToClient = this.sendToClientByRoom.get(roomId);
    if (item.kind === 'audio') {
      sendToClient?.(Buffer.concat([item.header, item.piece]));
    } else {
      sendToClient?.(serializeControlMessage(createEnvelope('speaking_end', roomId)));
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

export interface ClientConnection {
  ws: WebSocket;
  roomId: string;
  deviceId: string;
  authenticated: boolean;
}
