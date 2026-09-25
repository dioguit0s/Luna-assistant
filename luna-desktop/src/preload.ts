// Ponte de contexto isolado entre a janela oculta e o processo principal.
// Só expõe exatamente as 6 operações do protocolo de captura/playback —
// nada de nodeIntegration, nada de acesso genérico a ipcRenderer no renderer.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CAPTURE_ERROR,
  IPC_CAPTURE_READY,
  IPC_FLUSH_PLAYBACK,
  IPC_MIC_FRAME,
  IPC_PLAY_PCM,
  IPC_SET_AUDIO_DEVICES,
} from './main/ipc.js';

contextBridge.exposeInMainWorld('luna', {
  sendMicFrame: (buf: ArrayBuffer): void => {
    ipcRenderer.send(IPC_MIC_FRAME, buf);
  },
  sendCaptureError: (message: string): void => {
    ipcRenderer.send(IPC_CAPTURE_ERROR, message);
  },
  sendCaptureReady: (): void => {
    ipcRenderer.send(IPC_CAPTURE_READY);
  },
  onPlayPcm: (callback: (buf: ArrayBuffer) => void): void => {
    ipcRenderer.on(IPC_PLAY_PCM, (_event, buf: ArrayBuffer) => callback(buf));
  },
  onFlushPlayback: (callback: () => void): void => {
    ipcRenderer.on(IPC_FLUSH_PLAYBACK, () => callback());
  },
  onSetAudioDevices: (
    callback: (devices: { micDeviceId: string; speakerDeviceId: string }) => void,
  ): void => {
    ipcRenderer.on(IPC_SET_AUDIO_DEVICES, (_event, devices) => callback(devices));
  },
});
