import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
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
  devicesConfigPath: 'config/devices.json',
  deviceRegistryTtlMs: 300_000,
  providerConnectTimeoutMs: 5000,
  geminiVadSilenceMs: null,
  geminiVadEndSensitivity: null,
  geminiManualActivity: false,
  geminiThinkingBudget: 0,
  geminiDebugMessages: false,
  userSilenceCutoffMs: 500,
  openaiVadType: 'server_vad',
  openaiVadSilenceMs: null,
  openaiDebugMessages: false,
  openaiVoice: 'marin',
  dbPath: ':memory:',
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
    const haClient = new HomeAssistantClient(config);
    server = new WsServer(config, roomManager, haClient, new DeviceRegistrySource(haClient));
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
