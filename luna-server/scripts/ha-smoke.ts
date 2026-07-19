/**
 * Smoke test manual do relay real (LUNA-308).
 *
 *   node --import tsx scripts/ha-smoke.ts [entity_id]
 *
 * Lê o estado, liga, lê de novo, desliga. Precisa de HA_URL/HA_TOKEN no .env
 * e do ESP32 atuador ligado (LUNA-302).
 */
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/logging/logger.js';
import { HomeAssistantClient } from '../src/ha/HomeAssistantClient.js';

const entityId = process.argv[2] ?? 'switch.luz_bancada';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config);
  const client = new HomeAssistantClient(config);

  console.log(`HA: ${config.haUrl || '(HA_URL vazio!)'} — entidade: ${entityId}\n`);

  console.log('estado inicial:', await client.getState(entityId));

  console.log('turn_on ->', await client.callService('switch', 'turn_on', entityId));
  await sleep(1000);
  console.log('estado após turn_on:', await client.getState(entityId));

  console.log('turn_off ->', await client.callService('switch', 'turn_off', entityId));
  await sleep(1000);
  console.log('estado após turn_off:', await client.getState(entityId));
}

main().catch((err) => {
  console.error('Falha no smoke test do Home Assistant:', err);
  process.exit(1);
});
