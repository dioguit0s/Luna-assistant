import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeWeatherCode } from './wmo.js';

describe('describeWeatherCode', () => {
  it('traduz códigos conhecidos para texto falável em português', () => {
    assert.equal(describeWeatherCode(0), 'céu limpo');
    assert.equal(describeWeatherCode(3), 'nublado');
    assert.equal(describeWeatherCode(61), 'chuva fraca');
    assert.equal(describeWeatherCode(80), 'pancadas de chuva fracas');
    assert.equal(describeWeatherCode(95), 'tempestade');
  });

  it('devolve null para código desconhecido, nunca um texto inventado', () => {
    assert.equal(describeWeatherCode(42), null);
    assert.equal(describeWeatherCode(-1), null);
    assert.equal(describeWeatherCode(1000), null);
  });

  it('devolve null para valores que não são inteiro', () => {
    assert.equal(describeWeatherCode('3'), null);
    assert.equal(describeWeatherCode(undefined), null);
    assert.equal(describeWeatherCode(null), null);
    assert.equal(describeWeatherCode(3.5), null);
  });

  it('todo texto do mapa é falável: sem dígito, sem markdown, sem maiúscula inicial', () => {
    for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
      const texto = describeWeatherCode(code);
      assert.ok(texto, `código ${code} deveria estar no mapa`);
      assert.doesNotMatch(texto!, /\d/, `código ${code}: "${texto}" tem dígito`);
      assert.doesNotMatch(texto!, /[*_#`]/, `código ${code}: "${texto}" tem markdown`);
      assert.equal(texto, texto!.toLowerCase(), `código ${code}: "${texto}" não está em minúsculas`);
    }
  });
});
