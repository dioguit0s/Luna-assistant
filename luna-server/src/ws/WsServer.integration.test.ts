import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { computeAuthToken, validateAuthToken } from '../ws/auth.js';
import { serializeControlMessage, createEnvelope } from '../ws/protocol.js';

describe('integração WebSocket auth', () => {
  it('aceita conexão com token HMAC válido', async () => {
    const secret = 'test-secret';
    const deviceId = 'test-client-001';
    const token = computeAuthToken(secret, deviceId);

    const server = createServer();
    const wss = new WebSocketServer({ server });
    let authOk = false;

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          device_id?: string;
          token?: string;
          room_id: string;
        };
        if (msg.type === 'auth' && msg.device_id && msg.token) {
          if (validateAuthToken(secret, msg.device_id, msg.token)) {
            authOk = true;
            ws.send(serializeControlMessage(createEnvelope('auth_ok', msg.room_id)));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    ws.send(
      serializeControlMessage(
        createEnvelope('auth', 'sala-teste', { device_id: deviceId, token }),
      ),
    );

    await new Promise<void>((resolve) => {
      ws.on('message', () => resolve());
    });

    assert.equal(authOk, true);
    ws.close();
    wss.close();
    server.close();
  });
});
