import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { WsServer } from './WsServer.js';

const config: AppConfig = {
  audioProvider: 'gemini',
  geminiApiKey: 'test-key',
  openaiApiKey: '',
  wsAuthSecret: 'test-secret',
  wsPort: 0, // porta efêmera
  logLevel: 'silent',
  geminiLiveModel: 'test-model',
  openaiRealtimeModel: 'test-model',
  haUrl: '',
  haToken: '',
};

describe('GET /health', () => {
  let ringBuffer: ConversationRingBuffer;
  let roomManager: RoomManager;
  let server: WsServer;
  let baseUrl: string;

  before(async () => {
    createLogger(config);
    ringBuffer = new ConversationRingBuffer();
    roomManager = new RoomManager(config, ringBuffer);
    server = new WsServer(config, roomManager);
    server.start();

    while (server.port === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.stop();
    await roomManager.destroy();
    ringBuffer.destroy();
  });

  it('responde 200 com status ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { status: string; clients: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.clients, 0);
  });

  it('responde 404 em rotas desconhecidas', async () => {
    const res = await fetch(`${baseUrl}/nao-existe`);
    assert.equal(res.status, 404);
  });
});
