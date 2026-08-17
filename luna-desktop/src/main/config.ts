// Configuração do luna-desktop: .env na raiz do projeto + device_id
// persistido. Mesmo modelo de confiança do luna-client-test — o .env é
// gitignored e nunca deve ser commitado (pegadinha documentada no
// CLAUDE.md do repo).

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { app } from 'electron';

// De dist/main/ sobe dois níveis até a raiz do projeto — mesmo padrão do
// ASSETS_DIR em tray.ts, para que o .env seja achado tanto em dev (tsc solto)
// quanto rodando de dist/.
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Empacotado, dist/main/config.js mora dentro do app.asar — somente leitura,
// e um lugar que o usuário não tem como abrir/editar de verdade (shell.openPath
// não abre nada dentro de um asar). userData é o diretório certo pra config
// mutável (mesmo lugar de device.json/mic-dump); em dev mantém o comportamento
// de sempre, .env na raiz do projeto.
const ENV_DIR = app.isPackaged ? app.getPath('userData') : PROJECT_ROOT;

// Só existe empacotado (extraResources em electron-builder.yml) — usado só
// pra semear o .env na primeira execução, já que o usuário não tem o checkout
// do monorepo pra copiar .env.example à mão.
const ENV_EXAMPLE_PATH = app.isPackaged ? join(process.resourcesPath, '.env.example') : null;

// Exportado para o item de menu "Configurações" (shell.openPath) poder abrir
// o mesmo arquivo mesmo quando loadConfig() ainda não rodou com sucesso.
export const ENV_PATH = join(ENV_DIR, '.env');

export interface DesktopConfig {
  serverUrl: string;
  roomId: string;
  authSecret: string;
  deviceId: string;
  /** --model do sidecar de wake word. undefined = usa o default do próprio
   * wake_sidecar.py (hey_luna_trained.tflite) — não força essa decisão aqui. */
  wakewordModelPath?: string;
  /** --threshold do sidecar de wake word. undefined = usa o default do
   * próprio wake_sidecar.py (0.97). */
  wakewordThreshold?: number;
}

export class ConfigError extends Error {}

/**
 * device_id não é escolhido à mão (não há um MAC de ESP32 para usar): um UUID
 * é gerado na primeira execução e persistido em userData, cumprindo o mesmo
 * papel — identidade estável entre reinícios do app.
 */
function loadOrCreateDeviceId(): string {
  const dir = app.getPath('userData');
  const file = join(dir, 'device.json');

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { deviceId?: string };
      if (parsed.deviceId) return parsed.deviceId;
    } catch {
      // Arquivo corrompido — cai para gerar um novo abaixo em vez de travar o app.
    }
  }

  const deviceId = randomUUID();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ deviceId }, null, 2), 'utf8');
  return deviceId;
}

/**
 * Lança ConfigError (nunca lança exceção não tratada) quando o .env está
 * ausente ou incompleto — quem chama decide como refletir isso no tray
 * (estado 'error' + balão), em vez de a config derrubar o processo.
 */
export function loadConfig(): DesktopConfig {
  if (!existsSync(ENV_PATH)) {
    // Empacotado, semeia o .env a partir do modelo bundlado — sem isso o
    // usuário cairia num beco sem saída (não tem outro .env pra copiar, e o
    // diretório userData ainda nem existe na primeira execução).
    if (ENV_EXAMPLE_PATH && existsSync(ENV_EXAMPLE_PATH)) {
      mkdirSync(ENV_DIR, { recursive: true });
      copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      throw new ConfigError(
        `.env criado a partir do modelo em ${ENV_PATH} — preencha WS_AUTH_SECRET (pelo item "Configurações" do menu) e reinicie o app.`,
      );
    }
    throw new ConfigError(
      `.env não encontrado em ${ENV_PATH}. Copie .env.example para .env e preencha WS_AUTH_SECRET.`,
    );
  }
  loadDotenv({ path: ENV_PATH });

  const serverUrl = process.env.WS_SERVER_URL ?? 'ws://localhost:8080';
  const roomId = process.env.ROOM_ID ?? 'desktop_diogo';
  const authSecret = process.env.WS_AUTH_SECRET;

  if (!authSecret) {
    throw new ConfigError(
      `WS_AUTH_SECRET ausente em ${ENV_PATH} — precisa ser idêntico ao do luna-server.`,
    );
  }

  const deviceId = loadOrCreateDeviceId();

  const wakewordModelPath = process.env.WAKEWORD_MODEL || undefined;
  const rawThreshold = process.env.WAKEWORD_THRESHOLD;
  const wakewordThreshold = rawThreshold ? Number(rawThreshold) : undefined;
  if (rawThreshold && Number.isNaN(wakewordThreshold)) {
    throw new ConfigError(`WAKEWORD_THRESHOLD inválido em ${ENV_PATH}: "${rawThreshold}" não é um número.`);
  }

  console.log(`[luna-desktop] config carregada de ${ENV_PATH}`);
  console.log(`[luna-desktop] servidor=${serverUrl} sala=${roomId} device=${deviceId}`);

  return { serverUrl, roomId, authSecret, deviceId, wakewordModelPath, wakewordThreshold };
}
