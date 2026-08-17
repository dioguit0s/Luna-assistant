import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  APP_STATES,
  idleQualifier,
  stateLabel,
  tooltipFor,
  trayIconBaseName,
  trayIconFileName,
} from './state.js';

const assetsDir = fileURLToPath(new URL('../../assets/', import.meta.url));

describe('state', () => {
  it('dá rótulo em pt-BR para todo estado', () => {
    for (const state of APP_STATES) {
      assert.ok(stateLabel(state).length > 0, `estado sem rótulo: ${state}`);
    }
    assert.equal(stateLabel('idle'), 'Ociosa');
    assert.equal(stateLabel('listening'), 'Ouvindo');
  });

  it('monta o tooltip com o rótulo do estado', () => {
    assert.equal(tooltipFor('error'), 'Luna — Erro');
    assert.equal(tooltipFor('listening'), 'Luna — Ouvindo');
  });

  it('desambigua idle entre mudo e aguardando wake — os únicos dois estados que colidiam desde o M4', () => {
    assert.equal(tooltipFor('idle'), 'Luna — Ociosa (aguardando "Hey Luna")');
    assert.equal(tooltipFor('idle', false), 'Luna — Ociosa (aguardando "Hey Luna")');
    assert.equal(tooltipFor('idle', true), 'Luna — Ociosa (mudo)');
    assert.equal(idleQualifier(false), 'aguardando "Hey Luna"');
    assert.equal(idleQualifier(true), 'mudo');
  });

  it('usa um ícone distinto por estado', () => {
    const names = APP_STATES.map(trayIconBaseName);
    assert.equal(new Set(names).size, APP_STATES.length);
  });

  // Este é o teste que realmente paga o aluguel: o mapeamento pode estar
  // perfeito e o ícone simplesmente não existir (renomeado, gerador não
  // rodado). Sem isso a falha só aparece como bandeja vazia em runtime.
  it('tem os três PNGs de escala em assets/ para cada estado', () => {
    for (const state of APP_STATES) {
      const base = trayIconBaseName(state);
      for (const suffix of ['', '@1.5x', '@2x']) {
        const file = join(assetsDir, `${base}${suffix}.png`);
        assert.ok(existsSync(file), `ícone faltando: ${base}${suffix}.png (rode npm run icons)`);
      }
    }
    assert.equal(trayIconFileName('idle'), 'tray-idle.png');
  });
});
