// Autostart no login do Windows.
//
// Não há camada de persistência própria: a chave HKCU\...\CurrentVersion\Run
// que o Electron escreve é a única fonte consultada aqui.
//
// Ressalva: `openAtLogin` reflete só essa chave, não a flag "Desativado" que o
// Gerenciador de Tarefas grava em StartupApproved\Run — então desligar por lá
// não derruba o checkbox do menu (o Electron expõe
// `executableWillLaunchAtLogin` para considerar isso, não usado aqui em M1).

import { app } from 'electron';

/**
 * Ler e escrever precisam usar exatamente as mesmas `path`/`args`, senão o
 * getLoginItemSettings reporta `openAtLogin: false` para uma entrada que existe.
 *
 * Em desenvolvimento, `process.execPath` é o electron.exe de node_modules — sem
 * passar o caminho do projeto como primeiro argumento, o item de inicialização
 * subiria um Electron vazio. Com isso o toggle funciona também em dev.
 */
function loginItemOptions(): { path: string; args: string[] } {
  return {
    path: process.execPath,
    args: app.isPackaged ? ['--autostart'] : [app.getAppPath(), '--autostart'],
  };
}

export function isAutostartEnabled(): boolean {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

export function setAutostart(enabled: boolean): void {
  // `openAsHidden` é exclusivo do macOS — não usar aqui.
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: enabled });
}

/** Se o app subiu pelo item de inicialização. Ainda não consumido — M2 usa. */
export function wasAutoLaunched(): boolean {
  return process.argv.includes('--autostart');
}
