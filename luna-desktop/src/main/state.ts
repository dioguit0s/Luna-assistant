// Estados visíveis do satélite virtual. Espelham o StateMachine.h do firmware
// (IDLE_LISTENING / ACTIVE_STREAMING / RESPONDING) e acrescentam dois que o
// hardware não distingue: 'thinking' (janela de TTFAB) e 'error' (auth/conexão).
//
// Módulo puro de propósito: nada de `electron` aqui, para que o mapeamento
// estado→ícone possa ser testado com `node --test` sem subir o app.

export type AppState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export const APP_STATES: readonly AppState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'error',
];

// Record (e não switch com default) para que acrescentar um estado quebre o
// build aqui em vez de cair silenciosamente num caso genérico.
const LABELS: Record<AppState, string> = {
  idle: 'Ociosa',
  listening: 'Ouvindo',
  thinking: 'Pensando',
  speaking: 'Falando',
  error: 'Erro',
};

const ICON_BASE_NAMES: Record<AppState, string> = {
  idle: 'tray-idle',
  listening: 'tray-listening',
  thinking: 'tray-thinking',
  speaking: 'tray-speaking',
  error: 'tray-error',
};

/** Rótulo em pt-BR do estado, usado no menu e no tooltip. */
export function stateLabel(state: AppState): string {
  return LABELS[state];
}

/**
 * Nome-base do PNG em assets/, sem extensão e sem sufixo de escala — o Electron
 * resolve `@1.5x`/`@2x` sozinho a partir do arquivo base.
 */
export function trayIconBaseName(state: AppState): string {
  return ICON_BASE_NAMES[state];
}

/** Nome do arquivo base do ícone (com extensão). */
export function trayIconFileName(state: AppState): string {
  return `${trayIconBaseName(state)}.png`;
}

/**
 * Qualificador do estado 'idle', que desde o M4 cobre tanto "mudo" quanto
 * "aguardando um 'Hey Luna'" — indistinguíveis sem isso, porque os dois
 * mapeiam para o mesmo ícone/rótulo. Usado no cabeçalho do menu (menu.ts) e
 * no tooltip do tray (tray.ts) só quando state === 'idle'.
 */
export function idleQualifier(muted: boolean): string {
  return muted ? 'mudo' : 'aguardando "Hey Luna"';
}

/** Texto do tooltip do ícone de bandeja. */
export function tooltipFor(state: AppState, muted = false): string {
  const base = `Luna — ${stateLabel(state)}`;
  return state === 'idle' ? `${base} (${idleQualifier(muted)})` : base;
}
