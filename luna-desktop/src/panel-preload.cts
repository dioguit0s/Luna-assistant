// Preload da janela do painel. `.cts` → `panel-preload.cjs`: com `sandbox: true`
// o preload não carrega ESM nem módulo local — só `require('electron')`. Por
// isso os nomes de canal estão repetidos aqui (fonte: main/panel/window.ts).
//
// Expõe duas coisas e nada mais: chamar um método da whitelist do processo
// principal (main/panel/methods.ts) e ouvir eventos ao vivo. O token admin e
// os segredos ficam no processo principal; nada aqui os alcança.

import { contextBridge, ipcRenderer } from 'electron';

const PANEL_CALL_CHANNEL = 'luna-panel:call';
const PANEL_EVENT_CHANNEL = 'luna-panel:event';

contextBridge.exposeInMainWorld('panel', {
  call: (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(PANEL_CALL_CHANNEL, method, args),
  onEvent: (callback: (event: unknown) => void): void => {
    ipcRenderer.on(PANEL_EVENT_CHANNEL, (_event, payload: unknown) => callback(payload));
  },
});
