import { loadConfig } from './config/env.js';
import { createLogger, getLogger } from './logging/logger.js';
import { ConversationRingBuffer } from './rooms/ConversationRingBuffer.js';
import { RoomManager } from './rooms/RoomManager.js';
import { WsServer } from './ws/WsServer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

  const ringBuffer = new ConversationRingBuffer();
  const roomManager = new RoomManager(config, ringBuffer);
  const wsServer = new WsServer(config, roomManager);

  wsServer.start();

  getLogger().info(
    {
      provider: config.audioProvider,
      port: config.wsPort,
      event: 'server_start',
    },
    'Luna Server iniciado',
  );

  const shutdown = async (signal: string): Promise<void> => {
    getLogger().info({ signal, event: 'shutdown' }, 'Encerrando servidor...');
    await wsServer.stop();
    await roomManager.destroy();
    ringBuffer.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Falha ao iniciar Luna Server:', err);
  process.exit(1);
});
