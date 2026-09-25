// Configuração local do satélite desktop, editada pela tela "Este computador"
// do painel (docs/painel-de-controle.md, seção 8). Módulo puro — sem
// `electron`, testável com `node --test`: a cifra dos segredos (safeStorage)
// entra por injeção, via SecretCodec.
//
// Mesma regra do servidor (ADR 010): o .env é semente, o que o painel grava
// vence. Um .env antigo continua funcionando sem o usuário abrir o painel.

/** Forma gravada em userData/settings.json. Segredos cifrados, em base64. */
export interface StoredLocalSettings {
  serverUrl?: string;
  roomId?: string;
  micDeviceId?: string;
  speakerDeviceId?: string;
  /** Limiar da wake word (v2). Ausente = `WAKEWORD_THRESHOLD` do .env ou o default do sidecar. */
  wakeThreshold?: number;
  /** Accelerator do Electron para "falar agora" (v2). Ausente ou vazio = sem atalho. */
  talkShortcut?: string;
  /** Notificação do Windows quando um lembrete toca aqui (v2). Ausente = ligado. */
  reminderNotifications?: boolean;
  secrets?: {
    authSecret?: string;
    adminToken?: string;
  };
}

/** safeStorage do Electron (DPAPI no Windows) em produção; identidade nos testes. */
export interface SecretCodec {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

export type SecretSource = 'panel' | 'env' | 'none';

export interface ResolvedLocalSettings {
  serverUrl: string;
  roomId: string;
  authSecret: string;
  adminToken: string;
  micDeviceId: string;
  speakerDeviceId: string;
  wakeThreshold: number | null;
  talkShortcut: string;
  reminderNotifications: boolean;
  /** De onde veio cada segredo — o painel mostra, sem nunca mostrar o valor. */
  sources: { authSecret: SecretSource; adminToken: SecretSource };
}

/** O que o painel pode mandar. Segredo ausente = mantém; string vazia = apaga. */
export interface LocalSettingsPatch {
  serverUrl?: string;
  roomId?: string;
  micDeviceId?: string;
  speakerDeviceId?: string;
  /** `null` volta ao .env/default. */
  wakeThreshold?: number | null;
  /** Vazio desliga o atalho. */
  talkShortcut?: string;
  reminderNotifications?: boolean;
  authSecret?: string;
  adminToken?: string;
}

export class LocalSettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_SERVER_URL = 'ws://localhost:8080';
export const DEFAULT_ROOM_ID = 'desktop_diogo';

/**
 * Faixa do limiar exposta ao painel. Abaixo de 0.5 a wake word dispara com
 * qualquer conversa; o default do sidecar é 0.97.
 */
export const WAKE_THRESHOLD_MIN = 0.5;
export const WAKE_THRESHOLD_MAX = 0.999;

/** Accelerator do Electron: modificadores + uma tecla, separados por `+`. */
const SHORTCUT_PATTERN = /^((CommandOrControl|Control|Ctrl|Alt|Shift|Super|Meta)\+){1,3}[A-Za-z0-9]+$|^F([1-9]|1[0-9]|2[0-4])$/;

/** Mesmo formato que o luna-server exige no auth (ROOM_ID_PATTERN em WsServer.ts). */
const ROOM_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

function decryptOrEmpty(codec: SecretCodec, encoded: string | undefined): string {
  if (!encoded) return '';
  try {
    return codec.decrypt(encoded);
  } catch {
    // Segredo cifrado por outro usuário do Windows (ou userData copiado de
    // outra máquina): DPAPI não decifra. Cai para o .env em vez de travar.
    return '';
  }
}

export function resolveLocalSettings(
  env: Record<string, string | undefined>,
  stored: StoredLocalSettings,
  codec: SecretCodec,
): ResolvedLocalSettings {
  const panelSecret = decryptOrEmpty(codec, stored.secrets?.authSecret);
  const panelToken = decryptOrEmpty(codec, stored.secrets?.adminToken);
  const envSecret = env.WS_AUTH_SECRET?.trim() ?? '';
  const envToken = env.LUNA_ADMIN_TOKEN?.trim() ?? '';

  return {
    serverUrl: stored.serverUrl || env.WS_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    roomId: stored.roomId || env.ROOM_ID?.trim() || DEFAULT_ROOM_ID,
    authSecret: panelSecret || envSecret,
    adminToken: panelToken || envToken,
    micDeviceId: stored.micDeviceId ?? '',
    speakerDeviceId: stored.speakerDeviceId ?? '',
    wakeThreshold: typeof stored.wakeThreshold === 'number' ? stored.wakeThreshold : null,
    talkShortcut: stored.talkShortcut ?? '',
    reminderNotifications: stored.reminderNotifications ?? true,
    sources: {
      authSecret: panelSecret ? 'panel' : envSecret ? 'env' : 'none',
      adminToken: panelToken ? 'panel' : envToken ? 'env' : 'none',
    },
  };
}

/** Valida o patch e devolve o novo conteúdo de settings.json. Lança LocalSettingsError. */
export function applyLocalPatch(
  stored: StoredLocalSettings,
  patch: LocalSettingsPatch,
  codec: SecretCodec,
): StoredLocalSettings {
  const next: StoredLocalSettings = { ...stored, secrets: { ...stored.secrets } };

  if (patch.serverUrl !== undefined) {
    const url = patch.serverUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new LocalSettingsError('serverUrl', 'URL do servidor inválida.');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new LocalSettingsError('serverUrl', 'A URL do servidor começa com ws:// ou wss://.');
    }
    next.serverUrl = url.replace(/\/+$/, '');
  }

  if (patch.roomId !== undefined) {
    const room = patch.roomId.trim();
    if (!ROOM_ID_PATTERN.test(room)) {
      throw new LocalSettingsError('roomId', 'Sala: só minúsculas, dígitos e _ (até 64).');
    }
    next.roomId = room;
  }

  if (patch.micDeviceId !== undefined) next.micDeviceId = patch.micDeviceId;
  if (patch.speakerDeviceId !== undefined) next.speakerDeviceId = patch.speakerDeviceId;

  if (patch.wakeThreshold !== undefined) {
    if (patch.wakeThreshold === null) {
      delete next.wakeThreshold;
    } else if (
      typeof patch.wakeThreshold !== 'number' ||
      !Number.isFinite(patch.wakeThreshold) ||
      patch.wakeThreshold < WAKE_THRESHOLD_MIN ||
      patch.wakeThreshold > WAKE_THRESHOLD_MAX
    ) {
      throw new LocalSettingsError('wakeThreshold', `Sensibilidade entre ${WAKE_THRESHOLD_MIN} e ${WAKE_THRESHOLD_MAX}.`);
    } else {
      next.wakeThreshold = patch.wakeThreshold;
    }
  }

  if (patch.talkShortcut !== undefined) {
    const accel = String(patch.talkShortcut).trim();
    if (accel === '') delete next.talkShortcut;
    else if (!SHORTCUT_PATTERN.test(accel)) {
      throw new LocalSettingsError('talkShortcut', 'Atalho precisa de um modificador (Ctrl, Alt, Shift) e uma tecla, ou uma tecla F.');
    } else next.talkShortcut = accel;
  }

  if (patch.reminderNotifications !== undefined) {
    if (typeof patch.reminderNotifications !== 'boolean') {
      throw new LocalSettingsError('reminderNotifications', 'Notificações: liga ou desliga.');
    }
    next.reminderNotifications = patch.reminderNotifications;
  }

  for (const field of ['authSecret', 'adminToken'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value.trim() === '') {
      delete next.secrets![field];
      continue;
    }
    if (!codec.available()) {
      // Nunca gravar segredo em claro no disco: melhor recusar e deixar o .env.
      throw new LocalSettingsError(field, 'Cofre do sistema indisponível — segredo não gravado.');
    }
    next.secrets![field] = codec.encrypt(value.trim());
  }

  return next;
}

/**
 * Base HTTP da API admin a partir da URL do WebSocket: o servidor serve os dois
 * na mesma porta (ADR 010, decisão 1). ws→http, wss→https, sem caminho.
 */
export function adminBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

/** Os campos que exigem reconectar o WebSocket quando mudam. */
export function connectionChanged(a: ResolvedLocalSettings, b: ResolvedLocalSettings): boolean {
  return a.serverUrl !== b.serverUrl || a.roomId !== b.roomId || a.authSecret !== b.authSecret;
}
