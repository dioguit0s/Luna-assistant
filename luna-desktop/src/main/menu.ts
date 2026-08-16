// Template do menu de bandeja.
//
// IMPORTANTE: `electron` só pode ser importado aqui como *tipo* (`import type`,
// apagado na emissão). É isso que permite testar o menu com `node --test` fora
// do runtime do Electron — menu.test.ts falha na importação se alguém trocar
// por um import de valor.

import type { MenuItemConstructorOptions } from 'electron';
import { stateLabel, type AppState } from './state.js';

export interface TrayMenuOptions {
  state: AppState;
  autostartEnabled: boolean;
  /** M2 — sempre false enquanto não há captura de áudio. */
  micMuted: boolean;
  onToggleAutostart: (enabled: boolean) => void;
  onQuit: () => void;
  /** Callbacks ausentes deixam o item visível porém desabilitado. */
  onToggleMic?: () => void;
  onForceListen?: () => void;
  onOpenConfig?: () => void;
}

/**
 * Monta o template do menu com a forma final prevista no plano (docs/luna-desktop.md,
 * seção 6). Os itens de marcos futuros já aparecem, desabilitados: o menu não
 * muda de cara depois, e M2/M4 só precisam passar o callback correspondente.
 */
export function buildTrayMenuTemplate(options: TrayMenuOptions): MenuItemConstructorOptions[] {
  return [
    { label: `Luna — ${stateLabel(options.state)}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Mutar microfone',
      type: 'checkbox',
      checked: options.micMuted,
      enabled: options.onToggleMic !== undefined,
      click: () => options.onToggleMic?.(),
    },
    {
      label: 'Forçar escuta agora',
      enabled: options.onForceListen !== undefined,
      click: () => options.onForceListen?.(),
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: options.autostartEnabled,
      click: (item) => options.onToggleAutostart(item.checked),
    },
    {
      label: 'Configurações',
      enabled: options.onOpenConfig !== undefined,
      click: () => options.onOpenConfig?.(),
    },
    { type: 'separator' },
    { label: 'Sair', click: () => options.onQuit() },
  ];
}
