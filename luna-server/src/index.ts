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

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

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

  const wsServer = new WsServer(config, roomManager, haClient, deviceRegistry);

  wsServer.start();

  getLogger().info(
    {
      provider: config.audioProvider,
      port: config.wsPort,
      devices: deviceRegistry.current().size,
      event: 'server_start',
    },
    'Luna Server iniciado',
  );

  const shutdown = async (signal: string): Promise<void> => {
    getLogger().info({ signal, event: 'shutdown' }, 'Encerrando servidor...');
    await wsServer.stop();
    deviceRegistry.stop();
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
