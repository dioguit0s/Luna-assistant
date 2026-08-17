// HMAC do handshake de auth — idêntico a luna-client-test/src/config.ts e a
// luna-server/src/ws/auth.ts (computeAuthToken). O device_id é o único dado
// que entra na assinatura; room_id não participa.

import { createHmac } from 'node:crypto';

export function computeAuthToken(secret: string, deviceId: string): string {
  return createHmac('sha256', secret).update(deviceId).digest('hex');
}
