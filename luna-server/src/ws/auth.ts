import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeAuthToken(secret: string, deviceId: string): string {
  return createHmac('sha256', secret).update(deviceId).digest('hex');
}

export function validateAuthToken(
  secret: string,
  deviceId: string,
  token: string,
): boolean {
  const expected = computeAuthToken(secret, deviceId);
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const tokenBuf = Buffer.from(token, 'hex');
    if (expectedBuf.length !== tokenBuf.length) return false;
    return timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
}
