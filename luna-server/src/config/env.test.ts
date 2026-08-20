import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { resolveDbPath } from './env.js';

describe('resolveDbPath', () => {
  it('usa o $STATE_DIRECTORY do systemd quando não há override', () => {
    assert.equal(resolveDbPath(undefined, '/var/lib/luna-server'), '/var/lib/luna-server/luna.db');
  });

  it('com mais de um StateDirectory, fica com o primeiro', () => {
    // O systemd exporta a lista separada por ":" quando a unit declara vários.
    assert.equal(resolveDbPath(undefined, '/var/lib/a:/var/lib/b'), '/var/lib/a/luna.db');
  });

  it('LUNA_DB_PATH explícito vence o StateDirectory', () => {
    assert.equal(resolveDbPath('/srv/luna/alarmes.db', '/var/lib/luna-server'), '/srv/luna/alarmes.db');
  });

  it('devolve caminho absoluto mesmo com override relativo', () => {
    // Absoluto não é preciosismo: o `activate.sh` troca o symlink de
    // /opt/luna/current a cada deploy e poda as releases antigas — um caminho
    // relativo ao WorkingDirectory apontaria para o diretório que some.
    const caminho = resolveDbPath('estado/luna.db', undefined);
    assert.ok(isAbsolute(caminho), `esperava caminho absoluto, veio "${caminho}"`);
    assert.equal(caminho, resolve('estado/luna.db'));
  });

  it('sem systemd e sem override, cai no default de dev', () => {
    assert.equal(resolveDbPath(undefined, undefined), resolve('.luna-state', 'luna.db'));
  });
});
