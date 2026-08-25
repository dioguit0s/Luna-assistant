import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { parseCoordinate, resolveDbPath } from './env.js';

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

describe('parseCoordinate', () => {
  const VAR = 'TEST_COORDINATE';

  afterEach(() => {
    delete process.env[VAR];
  });

  it('ausente ou vazio devolve null', () => {
    assert.equal(parseCoordinate(VAR, 90), null);
    process.env[VAR] = '';
    assert.equal(parseCoordinate(VAR, 90), null);
  });

  it('aceita negativo — parseOptionalNumber rejeitaria, e o hemisfério sul é negativo', () => {
    process.env[VAR] = '-23.5505';
    assert.equal(parseCoordinate(VAR, 90), -23.5505);
  });

  it('aceita espaço em volta', () => {
    process.env[VAR] = ' -46.6333 ';
    assert.equal(parseCoordinate(VAR, 180), -46.6333);
  });

  it('lança fora da faixa', () => {
    process.env[VAR] = '200';
    assert.throws(() => parseCoordinate(VAR, 180), /inválido/);
  });

  it('lança para não-número', () => {
    process.env[VAR] = 'abc';
    assert.throws(() => parseCoordinate(VAR, 90), /inválido/);
  });
});
