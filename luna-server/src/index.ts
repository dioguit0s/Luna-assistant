import { loadConfig } from './config/env.js';
import { createLogger, getLogger } from './logging/logger.js';
import { HomeAssistantClient } from './ha/HomeAssistantClient.js';
import {
  DeviceRegistrySource,
  loadDeviceOverrides,
} from './ha/deviceRegistrySource.js';
import { ConversationRingBuffer } from './rooms/ConversationRingBuffer.js';
import { RoomManager } from './rooms/RoomManager.js';
import { WsServer } from './ws/WsServer.js';
import { ReminderStore } from './reminders/ReminderStore.js';
import { ReminderScheduler } from './reminders/ReminderScheduler.js';
import { nextDueAfter } from './reminders/recurrence.js';

/**
 * Loga com o pino se já estiver inicializado; cai para `console.error` durante
 * a janela entre o boot do processo e `createLogger(config)` — os handlers de
 * `unhandledRejection`/`uncaughtException` abaixo são registrados antes disso.
 */
function logFatal(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    getLogger().error({ event: kind, err: message }, `${kind} capturado: servidor continua no ar`);
  } catch {
    console.error(`[luna] ${kind} capturado (logger indisponível): servidor continua no ar`, message);
  }
}

// Rede de segurança de último recurso, não substituto dos `.catch` no caminho
// crítico (WsServer, Orchestrator, adapters): uma rejeição ou exceção que
// escapou de todos eles não pode derrubar o processo inteiro — isso mataria
// TODOS os cômodos simultaneamente (não só o que causou o erro) e, com o
// `Restart=always` do systemd, deixaria cada satélite mudo por até
// `RESPONDING_TIMEOUT_MS` (20s) até a próxima autenticação. Loga e segue.
//
// Trade-off consciente: a documentação do Node desaconselha retomar operação
// normal depois de um `uncaughtException` — o processo pode ficar num estado
// inconsistente em qualquer lugar, não só no ponto que gerou o erro. Aceito
// aqui porque a alternativa (deixar o processo morrer) é estritamente pior
// para este servidor: mata TODOS os cômodos por um erro que pode ser de UM
// único socket, e reinicia; se algo realmente corrompeu o estado global do
// processo, o próximo erro nesse mesmo estado vai aparecer de novo no log e
// pode justificar rever esta escolha — não um restart automático silencioso.
process.on('unhandledRejection', (reason) => logFatal('unhandled_rejection', reason));
process.on('uncaughtException', (err) => logFatal('uncaught_exception', err));

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

  // Antes de qualquer conexão: se o banco não abrir (permissão, corrupção,
  // Node sem `node:sqlite`), o processo morre aqui, o `health_ok` do
  // `activate.sh` falha e o rollback dispara. Falha barulhenta é o objetivo —
  // um fallback silencioso para `:memory:` faria os alarmes sumirem a cada
  // deploy sem nenhum sinal.
  const reminderStore = ReminderStore.open(config.dbPath);
  getLogger().info(
    { event: 'reminder_store_open', db_path: config.dbPath },
    'Banco de lembretes aberto',
  );

  const ringBuffer = new ConversationRingBuffer();
  const roomManager = new RoomManager(config, ringBuffer);

  const haClient = new HomeAssistantClient(config);
  const deviceRegistry = new DeviceRegistrySource(
    haClient,
    loadDeviceOverrides(config.devicesConfigPath),
    config.deviceRegistryTtlMs,
  );
  // Descobre os dispositivos antes de aceitar conexões; se o HA não responder,
  // sobe com os overrides e o refresh por TTL recupera depois.
  await deviceRegistry.start();

  // O ReminderScheduler só pode nascer depois do WsServer estar construído: o
  // onFire precisa do ciclo de toque que vive no Orchestrator lá dentro, e o
  // Orchestrator precisa do scheduler — para o handler de set_reminder chamar
  // reschedule(), e para o AlarmRinger rearmar o timer no fim de cada ciclo.
  // Nenhum dos dois nasce primeiro sozinho (ver o comentário em
  // Orchestrator.setReminderScheduler). `wsServer.start()` só roda depois de
  // tudo isto amarrado, de propósito: nenhuma conexão é aceita antes de o
  // scheduler existir para o handler chamar.
  const wsServer = new WsServer(config, roomManager, haClient, deviceRegistry, reminderStore);

  // O ciclo de toque (rajada → janela de escuta → rajada, dispensa, soneca e o
  // fallback de sala offline) vive no `AlarmRinger`, construído dentro do
  // Orchestrator porque o sink de áudio dele é o próprio Orchestrator.
  const alarmRinger = wsServer.getAlarmRinger();

  const reminderScheduler = new ReminderScheduler({
    store: reminderStore,
    // A promise só resolve no FIM do ciclo: é ela que segura a vaga em
    // `firingRooms` enquanto o alarme toca, impedindo que um segundo lembrete
    // da mesma sala seja disparado por cima.
    onFire: (reminder) => alarmRinger.ring(reminder),
    missedGraceMs: config.missedGraceMs,
    maxRingMs: config.alarmMaxRingMs,
    maxConcurrent: config.reminderMaxConcurrent,
    // Sem esta injeção vale o default `REFUSE_RECURRING`, que transforma todo
    // recorrente em `missed` — o lembrete de "todo dia útil às 6:30" tocaria
    // uma vez e sumiria.
    nextDueAfter,
  });

  wsServer.setReminderScheduler(reminderScheduler);
  // Rehydrate: fecha `ringing` órfão de um processo anterior e arma o timer a
  // partir do banco — é o que faz um alarme sobreviver ao deploy.
  reminderScheduler.start();

  wsServer.start();

  // Fingerprint da config de latência: cada bloco de logs diz sozinho sob
  // qual modelo/VAD/thinking as métricas (ttfab, model_decision_ms) valem —
  // sem isso, comparação antes/depois vira arqueologia de deploys.
  getLogger().info(
    {
      provider: config.audioProvider,
      port: config.wsPort,
      devices: deviceRegistry.current().size,
      model: config.geminiLiveModel,
      vad_silence_ms: config.geminiVadSilenceMs,
      thinking_budget: config.geminiThinkingBudget,
      event: 'server_start',
    },
    'Luna Server iniciado',
  );

  // Teto para o shutdown gracioso: `WsServer.stop()` espera o handshake de
  // close de cada peer, que pode nunca vir (satélite já sem energia). Sem um
  // teto, o systemd manda SIGKILL antes do `process.exit(0)` — o processo some
  // sem log de encerramento nenhum, dificultando diagnóstico de restart.
  const SHUTDOWN_TIMEOUT_MS = 5000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // Segundo SIGINT/SIGTERM durante o shutdown (ex.: operador impaciente
    // repetindo Ctrl+C) não pode reentrar e rodar `stop()`/`destroy()` duas
    // vezes em paralelo sobre o mesmo estado.
    if (shuttingDown) return;
    shuttingDown = true;

    getLogger().info({ signal, event: 'shutdown' }, 'Encerrando servidor...');

    const forceExit = setTimeout(() => {
      getLogger().warn({ event: 'shutdown_timeout' }, 'Shutdown gracioso excedeu o teto: forçando saída');
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    await wsServer.stop();
    deviceRegistry.stop();
    reminderScheduler.stop();
    // Antes do `reminderStore.close()`, e depois do scheduler: fechar um ciclo
    // de toque ESCREVE no banco (devolve o lembrete a `armed` ou o marca
    // `done`). Invertido, o shutdown estouraria "database is closed" dentro do
    // teto e o processo sairia sem log.
    alarmRinger.stop();
    await roomManager.destroy();
    ringBuffer.destroy();
    reminderStore.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Falha ao iniciar Luna Server:', err);
  process.exit(1);
});
