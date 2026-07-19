/**
 * Smoke manual da descoberta de dispositivos.
 *
 *   node --import tsx scripts/devices-smoke.ts [room_id]
 *
 * Lista o que a Luna enxerga no Home Assistant e, com um `room_id`, mostra como
 * um "ligar a luz" naquele cômodo seria resolvido. Só lê: `/api/template`
 * renderiza, não aciona nada.
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/logging/logger.js';
import { HomeAssistantClient } from '../src/ha/HomeAssistantClient.js';
import {
  DeviceRegistrySource,
  loadDeviceOverrides,
} from '../src/ha/deviceRegistrySource.js';

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);

  const source = new DeviceRegistrySource(
    new HomeAssistantClient(config),
    loadDeviceOverrides(config.devicesConfigPath),
    config.deviceRegistryTtlMs,
  );
  await source.refresh();
  source.stop();

  const registry = source.current();
  console.log(`\n${registry.size} dispositivos em ${registry.rooms.length} cômodos:`);
  for (const room of registry.rooms) {
    console.log(`\n  ${room}`);
    for (const entry of registry.devicesInRoom(room)) {
      console.log(`    ${entry.device.padEnd(24)} → ${entry.entityId}`);
    }
  }

  const roomId = process.argv[2];
  if (roomId) {
    const device = process.argv[3] ?? 'luz';
    const result = registry.resolve(device, roomId);
    console.log(
      `\nresolve("${device}", "${roomId}") →`,
      result.ok ? result.entry.entityId : `${result.reason}: ${result.error}`,
    );
  }
}

main().catch((err) => {
  console.error('Falha no smoke de descoberta:', err);
  process.exit(1);
});
