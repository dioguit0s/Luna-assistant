// Entrypoint do luna-desktop — marco 1: só bandeja, sem áudio e sem WebSocket.
//
// Nada de top-level await antes dos app.on(...): sob main ESM o módulo é
// avaliado de forma assíncrona e o evento 'ready' pode passar antes de os
// listeners serem registrados.

import { app } from 'electron';

import { createTray, type TrayController } from './tray.js';
import { wasAutoLaunched } from './autostart.js';

// Identidade do app no Windows (barra de tarefas, balões). Antes de tudo.
app.setAppUserModelId('com.diogo.luna.desktop');

let tray: TrayController | null = null;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Sai antes de criar qualquer Tray, senão a segunda instância pisca um ícone
  // duplicado na bandeja antes de morrer.
  console.log('[luna-desktop] outra instância já está rodando — encerrando');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    console.log(`[luna-desktop] segunda instância bloqueada (argv: ${argv.join(' ')})`);
    tray?.notify('Luna já está rodando', 'O ícone continua na bandeja.');
  });

  // Registrar o listener (mesmo vazio) cancela o default do Electron, que é
  // encerrar o app no Windows. Em M1 o evento nunca dispara — não há janela —
  // mas isso evita que a janela oculta de M2 mate o app ao fechar.
  app.on('window-all-closed', () => {
    // O app vive na bandeja; sair só pelo menu.
  });

  app.on('will-quit', () => {
    // Sem destroy o ícone vira fantasma na área de notificação.
    tray?.destroy();
    tray = null;
  });

  app.whenReady().then(() => {
    console.log(
      `[luna-desktop] v${app.getVersion()} (electron ${process.versions.electron}, node ${process.versions.node})`,
    );
    if (wasAutoLaunched()) {
      console.log('[luna-desktop] iniciado pelo autostart do Windows');
    }

    tray = createTray({ onQuit: () => app.quit() });
    tray.setState('idle');

    console.log('[luna-desktop] pronto — ícone na bandeja (pode estar no overflow "^")');
  }).catch((error) => {
    // Sem isso, um throw aqui dentro (ex.: o guard de createTray, ou o
    // Menu.buildFromTemplate) vira rejeição não tratada com o processo vivo,
    // sem tray e sem janela — o mesmo estado zumbi do ícone vazio em tray.ts.
    console.error('[luna-desktop] falha ao iniciar:', error);
    app.exit(1);
  });
}
