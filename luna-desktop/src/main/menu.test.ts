import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';

import { buildTrayMenuTemplate, type TrayMenuOptions } from './menu.js';

// O simples fato de este arquivo importar menu.js sob `node --test` (sem o
// runtime do Electron) já é o teste de arquitetura: se menu.ts trocar o
// `import type` por um import de valor, tudo aqui quebra com "Cannot find
// module 'electron'".

function baseOptions(overrides: Partial<TrayMenuOptions> = {}): TrayMenuOptions {
  return {
    state: 'idle',
    autostartEnabled: false,
    micMuted: false,
    onToggleAutostart: () => {},
    onQuit: () => {},
    ...overrides,
  };
}

function itemByLabel(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const found = template.find((entry) => entry.label === label);
  assert.ok(found, `item não encontrado no menu: ${label}`);
  return found;
}

/** O click do Electron recebe o MenuItem; nos testes só o `checked` importa. */
function click(item: MenuItemConstructorOptions, checked = false): void {
  assert.ok(item.click, `item sem handler: ${item.label}`);
  item.click({ checked } as MenuItem, undefined, {} as Electron.KeyboardEvent);
}

describe('buildTrayMenuTemplate', () => {
  it('mostra o estado atual no topo', () => {
    const template = buildTrayMenuTemplate(baseOptions({ state: 'speaking' }));
    assert.equal(template[0]?.label, 'Luna — Falando');
    assert.equal(template[0]?.enabled, false);
  });

  it('desambigua idle entre mudo e aguardando wake no cabeçalho', () => {
    const aguardando = buildTrayMenuTemplate(baseOptions({ state: 'idle', micMuted: false }));
    assert.equal(aguardando[0]?.label, 'Luna — Ociosa (aguardando "Hey Luna")');

    const mudo = buildTrayMenuTemplate(baseOptions({ state: 'idle', micMuted: true }));
    assert.equal(mudo[0]?.label, 'Luna — Ociosa (mudo)');
  });

  it('Sair chama onQuit', () => {
    let quit = false;
    const template = buildTrayMenuTemplate(baseOptions({ onQuit: () => (quit = true) }));
    click(itemByLabel(template, 'Sair'));
    assert.equal(quit, true);
  });

  it('desabilita os itens de marcos futuros quando não há callback', () => {
    const template = buildTrayMenuTemplate(baseOptions());
    assert.equal(itemByLabel(template, 'Mutar microfone').enabled, false);
    assert.equal(itemByLabel(template, 'Forçar escuta agora').enabled, false);
    assert.equal(itemByLabel(template, 'Configurações').enabled, false);
  });

  it('habilita o item assim que o callback é passado', () => {
    const template = buildTrayMenuTemplate(baseOptions({ onToggleMic: () => {} }));
    assert.equal(itemByLabel(template, 'Mutar microfone').enabled, true);
  });

  it('desabilita "Forçar escuta agora" enquanto mudo, mesmo com o callback presente', () => {
    const template = buildTrayMenuTemplate(
      baseOptions({ onForceListen: () => {}, micMuted: true }),
    );
    assert.equal(itemByLabel(template, 'Forçar escuta agora').enabled, false);

    const desmutado = buildTrayMenuTemplate(
      baseOptions({ onForceListen: () => {}, micMuted: false }),
    );
    assert.equal(itemByLabel(desmutado, 'Forçar escuta agora').enabled, true);
  });

  it('reflete o autostart no checkbox e repassa o novo valor', () => {
    const marcado = buildTrayMenuTemplate(baseOptions({ autostartEnabled: true }));
    assert.equal(itemByLabel(marcado, 'Iniciar com o Windows').checked, true);

    let recebido: boolean | undefined;
    const template = buildTrayMenuTemplate(
      baseOptions({ onToggleAutostart: (enabled) => (recebido = enabled) }),
    );
    click(itemByLabel(template, 'Iniciar com o Windows'), true);
    assert.equal(recebido, true);
  });
});
