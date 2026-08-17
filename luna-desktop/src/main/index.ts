// Entrypoint do luna-desktop — marco 2: round-trip de áudio sem wake word.
// Mic (Web Audio na janela oculta) -> audio_chunk -> luna-server ->
// audio_response -> alto-falante. Streaming contínuo, sem wake word ainda
// (M4). Ver docs/luna-desktop.md.
//
// Nada de top-level await antes dos app.on(...): sob main ESM o módulo é
// avaliado de forma assíncrona e o evento 'ready' pode passar antes de os
// listeners serem registrados.

import { app, shell } from 'electron';

import { createTray, type TrayController } from './tray.js';
import { wasAutoLaunched } from './autostart.js';
import { ConfigError, ENV_PATH, loadConfig } from './config.js';
import { Session } from './session.js';
import { LunaWsClient } from './ws/client.js';
import { createCaptureWindow, type CaptureWindow } from './window.js';
import { createMicDump, type MicDump } from './mic-dump.js';

// Identidade do app no Windows (barra de tarefas, balões). Antes de tudo.
app.setAppUserModelId('com.diogo.luna.desktop');

let tray: TrayController | null = null;
let session: Session | null = null;
let wsClient: LunaWsClient | null = null;
let captureWindow: CaptureWindow | null = null;
let micDump: MicDump | null = null;

function openConfig(): void {
  shell.openPath(ENV_PATH).then((errorMessage) => {
    if (errorMessage) {
      console.error(`[luna-desktop] falha ao abrir .env: ${errorMessage}`);
      tray?.notify('Luna — não consegui abrir o .env', `${ENV_PATH}\n${errorMessage}`);
    }
  });
}

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
  // encerrar o app no Windows. A janela oculta de captura não deve matar o
  // app ao "fechar" — só se sai pelo menu.
  app.on('window-all-closed', () => {
    // O app vive na bandeja; sair só pelo menu.
  });

  app.on('will-quit', () => {
    // Sem isso: ícone fantasma na bandeja, WS pendurado, janela oculta viva.
    wsClient?.stop();
    captureWindow?.destroy();
    session?.destroy();
    tray?.destroy();
    tray = null;
    // Fecha por último: quero capturar áudio até o instante do encerramento,
    // e o close() corrige o header do .wav (senão o arquivo fica com o
    // tamanho do placeholder e não toca).
    micDump?.close();
  });

  app.whenReady().then(() => {
    console.log(
      `[luna-desktop] v${app.getVersion()} (electron ${process.versions.electron}, node ${process.versions.node})`,
    );
    if (wasAutoLaunched()) {
      console.log('[luna-desktop] iniciado pelo autostart do Windows');
    }

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        // Não é um crash: o usuário corrige o .env e reinicia. O item
        // "Configurações" continua funcionando mesmo sem config carregada.
        console.error(`[luna-desktop] ${err.message}`);
        tray = createTray({ onQuit: () => app.quit(), onOpenConfig: openConfig });
        tray.setState('error');
        tray.notify('Luna — configuração incompleta', err.message);
        console.log('[luna-desktop] pronto, mas em erro — corrija o .env e reinicie');
        return;
      }
      throw err;
    }

    // Fixture de voz real para o sidecar de wake word (marco 3): opt-in só
    // por variável de ambiente, nunca por .env — grava o mic continuamente
    // enquanto ativo. Ver luna-desktop/wakeword-sidecar/README.md.
    micDump = createMicDump(app.getPath('userData'));

    session = new Session();

    wsClient = new LunaWsClient({
      serverUrl: config.serverUrl,
      roomId: config.roomId,
      authSecret: config.authSecret,
      deviceId: config.deviceId,
    });

    captureWindow = createCaptureWindow({
      onMicFrame: (pcm) => {
        // Antes do gate de uplink de propósito: a fixture de calibração do
        // wake word precisa do áudio inteiro (mudo, thinking, speaking
        // incluídos), não só do que chega a ser enviado ao servidor.
        micDump?.write(pcm);
        // A captura nunca para (necessário para o barge-in por wake word do
        // M4 mais tarde); só o envio ao servidor é fechado durante
        // thinking/speaking/mudo. Descartar aqui, não no renderer, mantém a
        // decisão de gate inteira no session.
        if (session?.isUplinkOpen()) wsClient?.sendAudio(pcm);
      },
      onCaptureError: (message) => {
        console.error(`[luna-desktop] erro de captura: ${message}`);
        tray?.notify('Luna — erro de microfone', message);
      },
      onCaptureReady: () => {
        console.log('[luna-desktop] captura de áudio pronta (mic + worklet)');
      },
    });

    session.on('stateChanged', (state) => tray?.setState(state));
    session.on('ttfab', (info) => {
      console.log(`[TTFAB] speaking_start→áudio: ${info.sinceSpeakingStartMs}ms`);
    });
    session.on('flushPlayback', () => captureWindow?.flushPlayback());

    wsClient.on('connecting', () => {
      console.log(`[luna-desktop] conectando a ${config.serverUrl}...`);
      session?.onConnecting();
    });
    wsClient.on('authOk', () => {
      console.log(`[luna-desktop] autenticado (device_id=${config.deviceId})`);
      session?.onAuthOk();
    });
    wsClient.on('authError', (reason) => {
      console.error(`[luna-desktop] auth falhou: ${reason ?? '(sem motivo)'}`);
      tray?.notify(
        'Luna — falha de autenticação',
        `${reason ?? 'motivo desconhecido'}\nConfira se WS_AUTH_SECRET bate com o luna-server.`,
      );
    });
    wsClient.on('closed', ({ code, reason }) => {
      console.warn(`[luna-desktop] WS desconectado (code=${code} reason="${reason}")`);
      session?.onDisconnected();
    });
    wsClient.on('reconnectScheduled', (delayMs) => {
      console.log(`[luna-desktop] reconectando em ${Math.round(delayMs / 1000)}s`);
    });
    wsClient.on('control', (envelope) => {
      if (envelope.type === 'speaking_start') {
        session?.onSpeakingStart();
      } else if (envelope.type === 'speaking_end') {
        session?.onSpeakingEnd();
      } else if (envelope.type === 'command_result') {
        const status = envelope.success ? 'ok' : 'falhou';
        console.log(
          `[command_result] ${envelope.device} → ${envelope.action} (${envelope.entity_id}): ${status}`,
        );
      }
    });
    wsClient.on('audio', (_envelope, pcm) => {
      const shouldPlay = session?.onAudioResponseFrame() ?? false;
      if (shouldPlay) captureWindow?.playPcm(pcm);
    });

    tray = createTray({
      onQuit: () => app.quit(),
      onToggleMic: () => session?.setMuted(!session.isMuted()),
      onForceListen: () => session?.forceListen(),
      onOpenConfig: openConfig,
      isMicMuted: () => session?.isMuted() ?? false,
    });
    tray.setState('error'); // até o primeiro authOk chegar

    wsClient.start();

    console.log('[luna-desktop] pronto — ícone na bandeja (pode estar no overflow "^")');
  }).catch((error) => {
    // Sem isso, um throw aqui dentro vira rejeição não tratada com o processo
    // vivo, sem tray e sem janela — o mesmo estado zumbi do ícone vazio em tray.ts.
    console.error('[luna-desktop] falha ao iniciar:', error);
    app.exit(1);
  });
}
