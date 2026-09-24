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
  /** De onde veio cada segredo — o painel mostra, sem nunca mostrar o valor. */
  sources: { authSecret: SecretSource; adminToken: SecretSource };
}

/** O que o painel pode mandar. Segredo ausente = mantém; string vazia = apaga. */
export interface LocalSettingsPatch {
  serverUrl?: string;
  roomId?: string;
  micDeviceId?: string;
  speakerDeviceId?: string;
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
