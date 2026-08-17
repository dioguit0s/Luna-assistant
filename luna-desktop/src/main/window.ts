// Janela oculta que dá acesso às Web APIs (getUserMedia, AudioWorklet,
// AudioContext) sem addon nativo. Não é UI — só existe pra existir. Ver
// docs/luna-desktop.md seção "Captura e playback: Web Audio no renderer".

import { BrowserWindow, ipcMain, session, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IPC_CAPTURE_ERROR,
  IPC_CAPTURE_READY,
  IPC_FLUSH_PLAYBACK,
  IPC_MIC_FRAME,
  IPC_PLAY_PCM,
} from './ipc.js';

// De dist/main/ sobe um nível até dist/ — preload.js e renderer/ vivem lá.
const DIST_DIR = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD_PATH = join(DIST_DIR, 'preload.js');
const RENDERER_INDEX = join(DIST_DIR, 'renderer', 'index.html');

export interface CaptureWindowDeps {
  onMicFrame: (pcm: Buffer) => void;
  onCaptureError: (message: string) => void;
  onCaptureReady: () => void;
}

export interface CaptureWindow {
  playPcm(pcm: Buffer): void;
  flushPlayback(): void;
  destroy(): void;
}

export function createCaptureWindow(deps: CaptureWindowDeps): CaptureWindow {
  // Não há usuário para clicar num prompt de permissão numa janela oculta —
  // libera "media" incondicionalmente em vez de deixar o Electron negar por
  // padrão (getUserMedia rejeitaria a Promise sem isso).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const debug = process.env.LUNA_DEBUG_WINDOW === '1';

  const win = new BrowserWindow({
    show: debug,
    width: 480,
    height: 200,
    title: 'Luna Desktop — captura (debug)',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // Preload em ESM (import de ./main/ipc.js) — o preload sandboxado
      // clássico do Electron não roda ESM. Não é conteúdo web arbitrário
      // (a página é a nossa própria renderer/index.html), então abrir mão do
      // sandbox aqui não expõe superfície nova de ataque.
      sandbox: false,
      // Timer de janela oculta é estrangulado pelo Chromium depois de alguns
      // minutos — sem isso o AudioContext e o worklet atrasariam sozinhos e
      // o app pareceria "surdo" de forma intermitente, sem erro nenhum.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(RENDERER_INDEX).catch((err: unknown) => {
    deps.onCaptureError(
      `falha ao carregar renderer: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Rede de segurança contra `sandbox: false`: nada no nosso renderer.ts
  // dispara navegação hoje, mas se algum dia aparecer (link, redirect,
  // window.open), isto impede sair de renderer/index.html sem exceção nem
  // abrir uma segunda janela sem sandbox por engano.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const onMicFrame = (_event: IpcMainEvent, buf: ArrayBuffer): void => {
    deps.onMicFrame(Buffer.from(buf));
  };
  const onCaptureError = (_event: IpcMainEvent, message: string): void => {
    deps.onCaptureError(message);
  };
  const onCaptureReady = (): void => deps.onCaptureReady();

  ipcMain.on(IPC_MIC_FRAME, onMicFrame);
  ipcMain.on(IPC_CAPTURE_ERROR, onCaptureError);
  ipcMain.on(IPC_CAPTURE_READY, onCaptureReady);

  return {
    playPcm(pcm: Buffer): void {
      if (win.isDestroyed()) return;
      // O Buffer pode ser uma view sobre um ArrayBuffer maior (subarray) —
      // fatiar pelos offsets exatos evita mandar bytes vizinhos como lixo.
      const arrayBuffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      win.webContents.send(IPC_PLAY_PCM, arrayBuffer);
    },
    flushPlayback(): void {
      if (win.isDestroyed()) return;
      win.webContents.send(IPC_FLUSH_PLAYBACK);
    },
    destroy(): void {
      ipcMain.off(IPC_MIC_FRAME, onMicFrame);
      ipcMain.off(IPC_CAPTURE_ERROR, onCaptureError);
      ipcMain.off(IPC_CAPTURE_READY, onCaptureReady);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
