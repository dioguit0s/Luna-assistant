// Ícone de bandeja: a única superfície de UI do luna-desktop.
//
// `setState` é o que a máquina de estados de M2/M4 vai chamar; nada mais do
// Tray deve vazar para o resto do app.

import { app, dialog, Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildTrayMenuTemplate } from './menu.js';
import { tooltipFor, trayIconFileName, APP_STATES, type AppState } from './state.js';
import { isAutostartEnabled, setAutostart } from './autostart.js';

// De dist/main/ sobe dois níveis até a raiz do projeto.
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url));

export interface TrayControllerDeps {
  onQuit: () => void;
  /** Ausentes = itens correspondentes ficam desabilitados (mesmo comportamento de M1). */
  onToggleMic?: () => void;
  onForceListen?: () => void;
  onOpenConfig?: () => void;
  /** Lido a cada abertura do menu, como isAutostartEnabled() — sem isso o checkbox travaria no valor de quando o tray foi criado. */
  isMicMuted?: () => boolean;
}

export interface TrayController {
  setState(state: AppState): void;
  getState(): AppState;
  notify(title: string, body: string): void;
  destroy(): void;
}

// Referência de módulo: um Tray coletado pelo GC faz o ícone sumir da bandeja
// sem erro nenhum — é a causa nº1 de "não aparece nada".
let tray: Tray | null = null;

/**
 * Carrega os PNGs de todos os estados de uma vez: evita I/O a cada transição e
 * falha no boot (visível) em vez de na primeira troca de estado (silenciosa).
 * O Electron resolve `@1.5x`/`@2x` sozinho a partir do arquivo base.
 *
 * Ícone vazio é tratado como fatal: `nativeImage.createFromPath` de um caminho
 * inexistente não lança, e `new Tray(imagemVazia)` também não — sem essa
 * checagem o app empacotado sobe sem ícone visível, sem janela e sem nenhum
 * caminho de saída além do Gerenciador de Tarefas.
 */
function loadIcons(): Map<AppState, NativeImage> {
  const icons = new Map<AppState, NativeImage>();
  for (const state of APP_STATES) {
    const file = join(ASSETS_DIR, trayIconFileName(state));
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) {
      const message = `Ícone não carregou: ${file}\n\nRode "npm run icons" e tente de novo.`;
      dialog.showErrorBox('Luna Desktop — falha ao iniciar', message);
      app.quit();
      throw new Error(`ícone vazio: ${file}`);
    }
    icons.set(state, image);
  }
  return icons;
}

export function createTray(deps: TrayControllerDeps): TrayController {
  if (tray) {
    throw new Error('createTray chamado duas vezes');
  }

  const icons = loadIcons();
  let currentState: AppState = 'idle';

  // Instância local: as closures abaixo capturam ESTA instância, não a
  // variável de módulo. Isso evita que um controller de uma execução anterior
  // (retido por engano após destroy()) acabe mexendo num Tray recriado depois.
  const trayInstance = new Tray(icons.get(currentState)!);
  tray = trayInstance; // âncora contra GC — ver comentário acima da variável.

  const refreshMenu = (): void => {
    const template = buildTrayMenuTemplate({
      state: currentState,
      // Lido a cada reconstrução — não cacheado — porque é a única garantia de
      // que o checkbox reflete o registro do Windows e não some estado antigo
      // (ex.: setAutostart falhou por política de grupo, ou o usuário mexeu
      // fora do app).
      autostartEnabled: isAutostartEnabled(),
      micMuted: deps.isMicMuted?.() ?? false,
      onToggleAutostart: (enabled) => {
        setAutostart(enabled);
        console.log(`[luna-desktop] autostart ${enabled ? 'ligado' : 'desligado'}`);
      },
      onQuit: deps.onQuit,
      onToggleMic: deps.onToggleMic,
      onForceListen: deps.onForceListen,
      onOpenConfig: deps.onOpenConfig,
    });
    trayInstance.setContextMenu(Menu.buildFromTemplate(template));
  };

  const applyState = (state: AppState): void => {
    currentState = state;
    trayInstance.setImage(icons.get(state)!);
    trayInstance.setToolTip(tooltipFor(state));
    // Reconstruir o menu (em vez de mutar labels) porque mutação de MenuItem já
    // construído é inconsistente no Windows, e o rótulo de estado fica no topo.
    refreshMenu();
  };

  applyState(currentState);

  // No Windows o clique esquerdo num tray não faz nada por padrão, o que
  // parece app travado. Reconstrói o menu (autostart pode ter mudado fora do
  // app desde a última vez) e abre o mesmo menu de contexto.
  trayInstance.on('click', () => {
    refreshMenu();
    trayInstance.popUpContextMenu();
  });

  return {
    setState(state: AppState): void {
      if (state === currentState) return;
      applyState(state);
    },
    getState(): AppState {
      return currentState;
    },
    notify(title: string, body: string): void {
      // displayBalloon em vez de Notification: fica ancorado no próprio ícone e
      // não depende de AppUserModelID registrado no sistema. É Windows-only.
      if (process.platform !== 'win32') {
        console.log(`[luna-desktop] ${title}: ${body}`);
        return;
      }
      trayInstance.displayBalloon({ title, content: body, iconType: 'info' });
    },
    destroy(): void {
      trayInstance.destroy();
      if (tray === trayInstance) tray = null;
    },
  };
}
