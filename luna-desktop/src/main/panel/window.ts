// Janela do painel de controle (ADR 010, decisão 6). Separada da janela
// oculta de captura de propósito — nenhuma das três escolhas daquela serve
// aqui:
//
// - lá `backgroundThrottling: false` protege o AudioWorklet; aqui a janela é
//   um renderer próprio, e uma interface pesada não disputa thread com o áudio;
// - lá a `session.defaultSession` libera `media` sem perguntar; aqui uma
//   `partition` própria nega toda permissão;
// - lá `sandbox: false` (preload ESM); aqui o painel exibe dado vindo de fora
//   (nomes do HA, rótulos de lembrete), então `sandbox: true`,
//   `contextIsolation`, preload mínimo em CommonJS e CSP restritiva no HTML.
//
// Fechar o painel destrói a janela e não encerra o app: o satélite continua
// escutando (window-all-closed em index.ts não faz nada).

import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PanelResult } from './methods.js';
import type { LogStreamEvent } from '../admin/logStream.js';

// De dist/main/panel/ sobe dois níveis até dist/.
const DIST_DIR = fileURLToPath(new URL('../..', import.meta.url));
const PRELOAD_PATH = join(DIST_DIR, 'panel-preload.cjs');
const PANEL_INDEX = join(DIST_DIR, 'panel', 'index.html');
const PARTITION = 'luna-panel';

/** Mesmos nomes do panel-preload.cts — lá não dá para importar daqui (preload sandboxado não carrega módulo local). */
export const PANEL_CALL_CHANNEL = 'luna-panel:call';
export const PANEL_EVENT_CHANNEL = 'luna-panel:event';

/** Eventos ao vivo main → painel. */
export type PanelEvent =
  | { type: 'local'; view: unknown }
  | { type: 'mic'; level: number }
  | { type: 'wake-score'; score: number; threshold: number | null }
  | { type: 'wake'; score: number }
  | LogStreamEvent;

export interface PanelController {
  open(tab?: string): void;
  isOpen(): boolean;
  send(event: PanelEvent): void;
  destroy(): void;
}

export function createPanelController(
  methods: Record<string, (...args: unknown[]) => Promise<PanelResult>>,
  /** Janela destruída: quem segura recurso por ela (o stream de log) solta aqui. */
  onClosed: () => void = () => {},
): PanelController {
  let win: BrowserWindow | null = null;

  const panelSession = session.fromPartition(PARTITION);
  panelSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  panelSession.setPermissionCheckHandler(() => false);

  const onCall = async (
    event: IpcMainInvokeEvent,
    method: unknown,
    args: unknown,
  ): Promise<PanelResult> => {
    // Só a nossa janela, e só pelos métodos da tabela.
    if (!win || event.sender !== win.webContents) {
      return { ok: false, status: 403, body: { error: 'origem não autorizada' } };
    }
    const fn = typeof method === 'string' && Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!fn) return { ok: false, status: 404, body: { error: `método desconhecido: ${String(method)}` } };
    return fn(...(Array.isArray(args) ? args : []));
  };
  ipcMain.handle(PANEL_CALL_CHANNEL, onCall);

  return {
    open(tab?: string): void {
      if (win && !win.isDestroyed()) {
        if (tab) win.webContents.send(PANEL_EVENT_CHANNEL, { type: 'navigate', tab });
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return;
      }

      win = new BrowserWindow({
        // Tamanho de referência do design (docs/design-system-painel.md).
        width: 1200,
        height: 760,
        minWidth: 960,
        minHeight: 600,
        show: false,
        title: 'LUNA 6000 — Painel de controle',
        autoHideMenuBar: true,
        backgroundColor: '#050805',
        webPreferences: {
          preload: PRELOAD_PATH,
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          spellcheck: false,
        },
      });
      win.removeMenu();

      const current = win;
      current.once('ready-to-show', () => current.show());
      current.on('closed', () => {
        if (win === current) win = null;
        onClosed();
      });
      current.webContents.on('will-navigate', (event) => event.preventDefault());
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      current
        .loadFile(PANEL_INDEX, tab ? { hash: tab } : undefined)
        .catch((err: unknown) => {
          console.error(`[luna-desktop] falha ao carregar o painel: ${err instanceof Error ? err.message : String(err)}`);
        });
    },

    isOpen(): boolean {
      return win !== null && !win.isDestroyed() && win.isVisible();
    },

    send(event: PanelEvent): void {
      if (!win || win.isDestroyed()) return;
      win.webContents.send(PANEL_EVENT_CHANNEL, event);
    },

    destroy(): void {
      ipcMain.removeHandler(PANEL_CALL_CHANNEL);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
