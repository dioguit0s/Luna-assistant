// Entrypoint do luna-desktop — satélite virtual + painel de controle.
// Mic (Web Audio na janela oculta) -> sidecar Python (detecção de "Hey Luna")
// + audio_chunk pro luna-server (só depois do wake) -> audio_response ->
// alto-falante. Ver docs/luna-desktop.md. O painel (Configurações, ADR 010) é
// uma janela a mais: fala com a API admin do servidor pelo processo principal
// e edita a configuração local deste satélite. Ver docs/painel-de-controle.md.
//
// Nada de top-level await antes dos app.on(...): sob main ESM o módulo é
// avaliado de forma assíncrona e o evento 'ready' pode passar antes de os
// listeners serem registrados.

// Primeiro de tudo: troca o userData antes de config.ts lê-lo (ver profile.ts).
import './profile.js';
import { app, dialog, globalShortcut, Notification, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTray, type TrayController } from './tray.js';
import { isAutostartEnabled, setAutostart, wasAutoLaunched } from './autostart.js';
import {
  ConfigError,
  loadConfig,
  loadOrCreateDeviceId,
  readLocalSettings,
  readWakewordOptions,
  saveLocalSettings,
  type DesktopConfig,
} from './config.js';
import {
  LocalSettingsError,
  connectionChanged,
  type ResolvedLocalSettings,
} from './local-settings.js';
import { Session } from './session.js';
import { LunaWsClient } from './ws/client.js';
import { createCaptureWindow, type CaptureWindow } from './window.js';
import { createMicDump, type MicDump } from './mic-dump.js';
import { WakewordSidecar } from './wakeword/sidecar.js';
import { AdminClient } from './admin/client.js';
import { LogStream } from './admin/logStream.js';
import { ReminderNotifier } from './reminder-notifier.js';
import { createPanelMethods, type LocalView } from './panel/methods.js';
import { createPanelController, type PanelController } from './panel/window.js';

// Identidade do app no Windows (barra de tarefas, balões). Antes de tudo.
app.setAppUserModelId('com.diogo.luna.desktop');

/** Cadência do score de wake word para o teste de mic do painel. */
const WAKE_SCORE_INTERVAL_MS = 200;
/** 5 frames de 20 ms: o medidor de nível do painel anda a 10 Hz. */
const MIC_LEVEL_EVERY_FRAMES = 5;

let tray: TrayController | null = null;
let session: Session | null = null;
let wsClient: LunaWsClient | null = null;
let captureWindow: CaptureWindow | null = null;
let micDump: MicDump | null = null;
let wakeword: WakewordSidecar | null = null;
let panel: PanelController | null = null;

/** Configuração local efetiva (settings.json por cima do .env). Relida a cada gravação. */
let local: ResolvedLocalSettings | null = null;
/** Por que o satélite não está conectado, quando não está por falta de configuração. */
let configError: string | null = null;
let wakeThreshold: number | null = null;
/** Atalho global em vigor e o erro do último registro, para a tela mostrar. */
let registeredShortcut = '';
let shortcutError: string | null = null;
let reminderNotifier: ReminderNotifier | null = null;
/** WAKEWORD_THRESHOLD do .env: vale quando o painel não escolheu nada. */
let envWakeThreshold: number | undefined;

/**
 * Troca o atalho global de "falar agora". `globalShortcut` só avisa o
 * aperto, não a soltura — por isso é "falar agora" (mesmo efeito do
 * "Forçar escuta" da bandeja), não segurar-para-falar.
 *
 * @returns `false` quando o sistema recusou (outro app já usa a combinação).
 */
function applyTalkShortcut(accel: string): boolean {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = '';
  shortcutError = null;
  if (!accel) return true;
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => session?.forceListen());
  } catch {
    ok = false;
  }
  if (!ok) {
    shortcutError = `O atalho ${accel} já está em uso por outro programa.`;
    console.warn(`[luna-desktop] ${shortcutError}`);
    return false;
  }
  registeredShortcut = accel;
  return true;
}

function localView(): LocalView {
  const current = local ?? readLocalSettings();
  return {
    serverUrl: current.serverUrl,
    roomId: current.roomId,
    deviceId: loadOrCreateDeviceId(),
    micDeviceId: current.micDeviceId,
    speakerDeviceId: current.speakerDeviceId,
    authSecret: { set: Boolean(current.authSecret), source: current.sources.authSecret },
    adminToken: { set: Boolean(current.adminToken), source: current.sources.adminToken },
    muted: session?.isMuted() ?? false,
    autostart: isAutostartEnabled(),
    wakeThreshold: current.wakeThreshold,
    wakeThresholdActive: wakeThreshold,
    talkShortcut: current.talkShortcut,
    talkShortcutError: shortcutError,
    reminderNotifications: current.reminderNotifications,
    state: session?.getState() ?? 'error',
    configError,
    version: app.getVersion(),
  };
}

function pushLocalView(): void {
  panel?.send({ type: 'local', view: localView() });
}

/**
 * (Re)cria o cliente WS. Chamado no boot e sempre que o painel muda servidor,
 * sala ou segredo — `stop()` não emite 'closed', então a sessão é avisada
 * aqui mesmo, senão o estado ficaria "conectado" até o novo authOk.
 */
function connectServer(config: DesktopConfig): void {
  if (wsClient) {
    wsClient.stop();
    session?.onDisconnected();
  }

  const client = new LunaWsClient({
    serverUrl: config.serverUrl,
    roomId: config.roomId,
    authSecret: config.authSecret,
    deviceId: config.deviceId,
  });
  wsClient = client;

  client.on('connecting', () => {
    console.log(`[luna-desktop] conectando a ${config.serverUrl}...`);
    session?.onConnecting();
  });
  client.on('authOk', () => {
    console.log(`[luna-desktop] autenticado (device_id=${config.deviceId})`);
    session?.onAuthOk();
  });
  client.on('authError', (reason) => {
    console.error(`[luna-desktop] auth falhou: ${reason ?? '(sem motivo)'}`);
    tray?.notify(
      'Luna — falha de autenticação',
      `${reason ?? 'motivo desconhecido'}\nConfira o segredo em Configurações → Este computador.`,
    );
  });
  client.on('closed', ({ code, reason }) => {
    console.warn(`[luna-desktop] WS desconectado (code=${code} reason="${reason}")`);
    session?.onDisconnected();
  });
  client.on('reconnectScheduled', (delayMs) => {
    console.log(`[luna-desktop] reconectando em ${Math.round(delayMs / 1000)}s`);
  });
  client.on('control', (envelope) => {
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
  client.on('audio', (_envelope, pcm) => {
    const shouldPlay = session?.onAudioResponseFrame() ?? false;
    if (shouldPlay) captureWindow?.playPcm(pcm);
  });

  client.start();
}

/** Tenta subir a conexão com a config atual; sem segredo, fica em 'error' e diz por quê. */
function tryConnect(): void {
  try {
    const config = loadConfig();
    configError = null;
    connectServer(config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    configError = err.message;
    console.error(`[luna-desktop] ${err.message}`);
    if (wsClient) {
      wsClient.stop();
      wsClient = null;
      session?.onDisconnected();
    }
  }
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
    // Abrir o app de novo é o gesto natural de quem quer as configurações.
    panel?.open();
  });

  // Registrar o listener (mesmo vazio) cancela o default do Electron, que é
  // encerrar o app no Windows. Nem a janela oculta de captura nem o painel
  // matam o app ao fechar — só se sai pelo menu.
  app.on('window-all-closed', () => {
    // O app vive na bandeja; sair só pelo menu.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    reminderNotifier?.stop();
    // Sem isso: ícone fantasma na bandeja, WS pendurado, janelas vivas,
    // sidecar Python órfão.
    wsClient?.stop();
    wakeword?.stop();
    panel?.destroy();
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

    local = readLocalSettings();

    // Fixture de voz real para o sidecar de wake word (marco 3): opt-in só
    // por variável de ambiente, nunca por .env — grava o mic continuamente
    // enquanto ativo. Ver luna-desktop/wakeword-sidecar/README.md.
    micDump = createMicDump(app.getPath('userData'));

    session = new Session();

    let wakeOptions: ReturnType<typeof readWakewordOptions> = {};
    try {
      wakeOptions = readWakewordOptions();
    } catch (err) {
      // Threshold inválido no .env não pode impedir o painel de abrir.
      console.error(`[luna-desktop] ${err instanceof Error ? err.message : String(err)}`);
    }
    envWakeThreshold = wakeOptions.wakewordThreshold;
    wakeword = new WakewordSidecar({
      model: wakeOptions.wakewordModelPath,
      // O painel vence o .env, como no resto da configuração local.
      threshold: local.wakeThreshold ?? envWakeThreshold,
      scoreIntervalMs: WAKE_SCORE_INTERVAL_MS,
    });

    let levelFrames = 0;
    let levelSumSquares = 0;
    let levelSamples = 0;

    captureWindow = createCaptureWindow({
      onMicFrame: (pcm) => {
        // Antes de qualquer gate de propósito: a fixture de calibração do
        // wake word precisa do áudio inteiro (mudo, thinking, speaking
        // incluídos), não só do que chega a ser enviado ao servidor.
        micDump?.write(pcm);
        // Medidor do teste de mic: só calcula com o painel aberto.
        if (panel?.isOpen()) {
          for (let i = 0; i + 1 < pcm.length; i += 2) {
            const sample = pcm.readInt16LE(i);
            levelSumSquares += sample * sample;
          }
          levelSamples += pcm.length / 2;
          if (++levelFrames >= MIC_LEVEL_EVERY_FRAMES) {
            const rms = Math.sqrt(levelSumSquares / Math.max(1, levelSamples)) / 0x8000;
            panel.send({ type: 'mic', level: rms });
            levelFrames = 0;
            levelSumSquares = 0;
            levelSamples = 0;
          }
        }
        // A captura nunca para (necessário para o barge-in por wake word);
        // só o que sai dela é fechado. Mudo pausa a alimentação do sidecar
        // também — mudo deve mutar tudo, incluindo detecção de wake.
        if (!session?.isMuted()) wakeword?.feed(pcm);
        // O envio ao servidor é fechado durante thinking/speaking/mudo/
        // aguardando-wake. Descartar aqui, não no renderer, mantém a decisão
        // de gate inteira no session.
        if (session?.isUplinkOpen()) wsClient?.sendAudio(pcm);
      },
      onCaptureError: (message) => {
        console.error(`[luna-desktop] erro de captura: ${message}`);
        tray?.notify('Luna — erro de microfone', message);
      },
      onCaptureReady: () => {
        console.log('[luna-desktop] captura de áudio pronta (mic + worklet)');
        // Aplica o mic/alto-falante escolhidos no painel; vazio = padrão.
        if (local && (local.micDeviceId || local.speakerDeviceId)) {
          captureWindow?.setAudioDevices(local.micDeviceId, local.speakerDeviceId);
        }
      },
    });

    session.on('stateChanged', (state) => {
      tray?.setState(state);
      pushLocalView();
    });
    session.on('ttfab', (info) => {
      console.log(`[TTFAB] speaking_start→áudio: ${info.sinceSpeakingStartMs}ms`);
    });
    session.on('flushPlayback', () => captureWindow?.flushPlayback());

    wakeword.on('ready', (info) => {
      console.log(`[luna-desktop] wakeword pronto (modelo=${info.model} threshold=${info.threshold})`);
      wakeThreshold = info.threshold;
      session?.setSidecarHealthy(true);
      // Limiar trocado pelo painel reinicia o sidecar: a tela mostra o novo.
      pushLocalView();
    });
    wakeword.on('wake', (info) => {
      console.log(`[luna-desktop] wake detectado (mean_prob=${info.mean_prob.toFixed(3)})`);
      panel?.send({ type: 'wake', score: info.mean_prob });
      session?.onWakeDetected();
    });
    wakeword.on('score', (info) => {
      if (panel?.isOpen()) panel.send({ type: 'wake-score', score: info.mean_prob, threshold: wakeThreshold });
    });
    wakeword.on('crashed', ({ code }) => {
      console.warn(`[luna-desktop] wakeword sidecar saiu (code=${code}) — reiniciando`);
      session?.setSidecarHealthy(false);
    });
    wakeword.on('fatalError', (message) => {
      session?.setSidecarHealthy(false);
      tray?.notify('Luna — wake word indisponível', message);
    });
    wakeword.on('restartScheduled', (delayMs) => {
      console.log(`[luna-desktop] wakeword: reiniciando em ${Math.round(delayMs / 1000)}s`);
    });

    const adminConnection = () => ({
      serverUrl: (local ?? readLocalSettings()).serverUrl,
      adminToken: (local ?? readLocalSettings()).adminToken,
    });
    const admin = new AdminClient(adminConnection);
    const logStream = new LogStream(adminConnection, (event) => panel?.send(event));

    panel = createPanelController(
      createPanelMethods({
        admin,
        logs: logStream,
        files: {
          async saveJson(defaultName, data) {
            const { canceled, filePath } = await dialog.showSaveDialog({
              title: 'Luna — salvar backup',
              defaultPath: join(app.getPath('documents'), defaultName),
              filters: [{ name: 'Backup da Luna', extensions: ['json'] }],
            });
            if (canceled || !filePath) return null;
            await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            return filePath;
          },
          async openJson() {
            const { canceled, filePaths } = await dialog.showOpenDialog({
              title: 'Luna — restaurar backup',
              properties: ['openFile'],
              filters: [{ name: 'Backup da Luna', extensions: ['json'] }],
            });
            if (canceled || !filePaths[0]) return null;
            // Tamanho em bytes ANTES de ler: um arquivo de GB escolhido por
            // engano travaria o processo principal. O servidor aceita até 1 MB.
            const { size } = await stat(filePaths[0]);
            if (size > 1024 * 1024) throw new Error('Arquivo grande demais para ser um backup da Luna.');
            return JSON.parse(await readFile(filePaths[0], 'utf8')) as unknown;
          },
        },
        local: {
          view: localView,
          async save(patch) {
            const before = local ?? readLocalSettings();
            // Atalho: testa o registro ANTES de gravar — gravar um atalho que
            // o Windows recusou deixaria a tela dizendo que ele existe.
            if (patch.talkShortcut !== undefined && patch.talkShortcut.trim() !== before.talkShortcut) {
              if (!applyTalkShortcut(patch.talkShortcut.trim())) {
                const failed = shortcutError ?? 'Atalho recusado pelo sistema.';
                applyTalkShortcut(before.talkShortcut);
                throw new LocalSettingsError('talkShortcut', failed);
              }
            }
            // Os segredos gravados seguem a URL do servidor: o token admin e o
            // segredo do satélite passam a ir para o host novo. Um renderer do
            // painel comprometido poderia mudar a URL para exfiltrá-los — a
            // confirmação é um diálogo nativo, fora do alcance dele.
            const newUrl = patch.serverUrl?.trim().replace(/\/+$/, '');
            const secretsFollow =
              (before.adminToken && patch.adminToken === undefined) ||
              (before.authSecret && patch.authSecret === undefined);
            if (newUrl && newUrl !== before.serverUrl && secretsFollow) {
              const { response } = await dialog.showMessageBox({
                type: 'question',
                buttons: ['Trocar servidor', 'Cancelar'],
                defaultId: 1,
                cancelId: 1,
                title: 'Luna — trocar servidor',
                message: `Usar o servidor ${newUrl}?`,
                detail:
                  'O segredo do satélite e o token admin já gravados passam a ser enviados para ele. ' +
                  'Confirme só se foi você quem pediu essa troca.',
              });
              if (response !== 0) throw new LocalSettingsError('serverUrl', 'Troca de servidor cancelada.');
            }
            local = saveLocalSettings(patch);
            if (patch.wakeThreshold !== undefined) {
              wakeword?.setThreshold(local.wakeThreshold ?? envWakeThreshold);
            }
            if (patch.micDeviceId !== undefined || patch.speakerDeviceId !== undefined) {
              captureWindow?.setAudioDevices(local.micDeviceId, local.speakerDeviceId);
            }
            if (connectionChanged(before, local) || (!wsClient && local.authSecret)) {
              console.log('[luna-desktop] conexão alterada pelo painel — reconectando');
              tryConnect();
            }
            const view = localView();
            pushLocalView();
            return view;
          },
          setMuted(muted) {
            session?.setMuted(muted);
            tray?.setState(session?.getState() ?? 'error');
            pushLocalView();
          },
          forceListen() {
            session?.forceListen();
          },
          setAutostart(enabled) {
            setAutostart(enabled);
            console.log(`[luna-desktop] autostart ${enabled ? 'ligado' : 'desligado'} (painel)`);
          },
          openDataDir() {
            void shell.openPath(app.getPath('userData'));
          },
          listAudioDevices: () => captureWindow?.listAudioDevices() ?? Promise.resolve([]),
        },
      }),
      () => logStream.stop(false),
    );

    tray = createTray({
      onQuit: () => app.quit(),
      onToggleMic: () => {
        session?.setMuted(!session.isMuted());
        pushLocalView();
      },
      onForceListen: () => session?.forceListen(),
      onOpenConfig: () => panel?.open(),
      isMicMuted: () => session?.isMuted() ?? false,
    });
    tray.setState('error'); // até o primeiro authOk chegar

    wakeword.start();
    tryConnect();

    applyTalkShortcut(local.talkShortcut);
    reminderNotifier = new ReminderNotifier(
      admin,
      () => (local ?? readLocalSettings()).roomId,
      (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
      },
      // Sem token admin a API nem existe para este app: não adianta perguntar.
      () => {
        const current = local ?? readLocalSettings();
        return current.reminderNotifications && Boolean(current.adminToken);
      },
    );
    reminderNotifier.start();

    if (configError) {
      // Não é um crash: falta configuração. Em vez de mandar editar um .env,
      // abre o painel direto na tela que resolve.
      tray.notify('Luna — configuração incompleta', configError);
      panel.open('local');
      console.log('[luna-desktop] pronto, mas sem servidor configurado — painel aberto');
      return;
    }

    console.log('[luna-desktop] pronto — ícone na bandeja (pode estar no overflow "^")');
  }).catch((error) => {
    // Sem isso, um throw aqui dentro vira rejeição não tratada com o processo
    // vivo, sem tray e sem janela — o mesmo estado zumbi do ícone vazio em tray.ts.
    console.error('[luna-desktop] falha ao iniciar:', error);
    app.exit(1);
  });
}
