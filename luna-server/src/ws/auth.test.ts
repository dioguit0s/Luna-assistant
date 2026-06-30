import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAuthToken, validateAuthToken } from './auth.js';

describe('auth HMAC', () => {
  const secret = 'test-secret';
  const deviceId = 'test-client-001';

  it('gera token determinístico', () => {
    const t1 = computeAuthToken(secret, deviceId);
    const t2 = computeAuthToken(secret, deviceId);
    assert.equal(t1, t2);
    assert.equal(t1.length, 64);
  });

  it('valida token correto', () => {
    const token = computeAuthToken(secret, deviceId);
    assert.equal(validateAuthToken(secret, deviceId, token), true);
  });

  it('rejeita token inválido', () => {
    assert.equal(validateAuthToken(secret, deviceId, 'deadbeef'), false);
  });
});
