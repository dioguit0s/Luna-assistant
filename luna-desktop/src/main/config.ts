// Configuração do luna-desktop: userData/settings.json (gravado pelo painel,
// segredos cifrados com safeStorage) por cima de um .env opcional, mais o
// device_id persistido. O .env continua gitignored e nunca deve ser
// commitado (pegadinha documentada no CLAUDE.md do repo).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { app, safeStorage } from 'electron';

import {
  applyLocalPatch,
  resolveLocalSettings,
  type LocalSettingsPatch,
  type ResolvedLocalSettings,
  type SecretCodec,
  type StoredLocalSettings,
} from './local-settings.js';

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

// Desde o painel (ADR 010) o .env é opcional: só semeia. Continua lido para
// quem já tinha um e para os knobs de diagnóstico (WAKEWORD_*).
export const ENV_PATH = join(ENV_DIR, '.env');

/** O que o painel grava na tela "Este computador". */
export const SETTINGS_PATH = join(app.getPath('userData'), 'settings.json');

export interface DesktopConfig {
  serverUrl: string;
  roomId: string;
  authSecret: string;
  deviceId: string;
  /** Token da API admin do servidor. Vazio = painel sem as telas do servidor. */
  adminToken: string;
  /** deviceId do Web Audio; vazio = padrão do sistema. */
  micDeviceId: string;
  speakerDeviceId: string;
  /** --model do sidecar de wake word. undefined = usa o default do próprio
   * wake_sidecar.py (hey_luna_trained.tflite) — não força essa decisão aqui. */
  wakewordModelPath?: string;
  /** --threshold do sidecar de wake word. undefined = usa o default do
   * próprio wake_sidecar.py (0.97). */
  wakewordThreshold?: number;
}

export class ConfigError extends Error {}

/**
 * DPAPI no Windows: só o mesmo usuário na mesma máquina decifra. O token admin
 * e o segredo WS ficam aqui, no processo principal — a janela do painel nunca
 * os vê (ADR 010, decisão 2).
 */
const codec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
};

/**
 * device_id não é escolhido à mão (não há um MAC de ESP32 para usar): um UUID
 * é gerado na primeira execução e persistido em userData, cumprindo o mesmo
 * papel — identidade estável entre reinícios do app.
 */
export function loadOrCreateDeviceId(): string {
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
 * `parse`, não `config()`: o dotenv não sobrescreve o que já está em
 * `process.env`, então reler depois de uma edição devolveria o valor velho.
 */
function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  try {
    return parseDotenv(readFileSync(ENV_PATH));
  } catch (err) {
    console.error(`[luna-desktop] .env ilegível em ${ENV_PATH}: ${String(err)}`);
    return {};
  }
}

function readStored(): StoredLocalSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as StoredLocalSettings;
  } catch {
    console.error(`[luna-desktop] ${SETTINGS_PATH} corrompido — usando só o .env`);
    return {};
  }
}

/** A configuração local efetiva: settings.json por cima do .env. Nunca lança. */
export function readLocalSettings(): ResolvedLocalSettings {
  return resolveLocalSettings({ ...process.env, ...readEnvFile() }, readStored(), codec);
}

/**
 * Valida, cifra os segredos e grava. Escrita atômica (tmp + rename): um crash
 * no meio não pode deixar o settings.json truncado e o app sem configuração.
 */
export function saveLocalSettings(patch: LocalSettingsPatch): ResolvedLocalSettings {
  const next = applyLocalPatch(readStored(), patch, codec);
  mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, SETTINGS_PATH);
  return readLocalSettings();
}

/**
 * Lança ConfigError (nunca exceção não tratada) quando falta o segredo WS —
 * quem chama deixa o app em 'error' e abre o painel em "Este computador".
 */
/**
 * Knobs de diagnóstico do sidecar, só pelo .env. Separado de `loadConfig`
 * porque o sidecar sobe mesmo sem servidor configurado — o teste de mic do
 * painel precisa dele para completar a configuração.
 */
export function readWakewordOptions(
  env: Record<string, string | undefined> = { ...process.env, ...readEnvFile() },
): { wakewordModelPath?: string; wakewordThreshold?: number } {
  const wakewordModelPath = env.WAKEWORD_MODEL || undefined;
  const rawThreshold = env.WAKEWORD_THRESHOLD;
  const wakewordThreshold = rawThreshold ? Number(rawThreshold) : undefined;
  if (rawThreshold && Number.isNaN(wakewordThreshold)) {
    throw new ConfigError(`WAKEWORD_THRESHOLD inválido em ${ENV_PATH}: "${rawThreshold}" não é um número.`);
  }
  return { wakewordModelPath, wakewordThreshold };
}

export function loadConfig(): DesktopConfig {
  const env = { ...process.env, ...readEnvFile() };
  const local = readLocalSettings();

  if (!local.authSecret) {
    throw new ConfigError(
      'Segredo do servidor (WS_AUTH_SECRET) não configurado — preencha em Configurações → Este computador.',
    );
  }

  const deviceId = loadOrCreateDeviceId();
  const { wakewordModelPath, wakewordThreshold } = readWakewordOptions(env);

  console.log(`[luna-desktop] servidor=${local.serverUrl} sala=${local.roomId} device=${deviceId}`);

  return {
    serverUrl: local.serverUrl,
    roomId: local.roomId,
    authSecret: local.authSecret,
    adminToken: local.adminToken,
    micDeviceId: local.micDeviceId,
    speakerDeviceId: local.speakerDeviceId,
    deviceId,
    wakewordModelPath,
    wakewordThreshold,
  };
}
