import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { ConversationRingBuffer } from '../rooms/ConversationRingBuffer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { HomeAssistantClient } from '../ha/HomeAssistantClient.js';
import { DeviceRegistrySource } from '../ha/deviceRegistrySource.js';
import { WsServer } from './WsServer.js';
import { computeAuthToken } from './auth.js';
import { createEnvelope, parseControlMessage, serializeControlMessage } from './protocol.js';

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

describe('WsServer: endurecimento da borda', () => {
  let ringBuffer: ConversationRingBuffer;
  let roomManager: RoomManager;
  let server: WsServer;
  let wsUrl: string;

  before(async () => {
    createLogger(config);
  });

  beforeEach(async () => {
    ringBuffer = new ConversationRingBuffer();
    roomManager = new RoomManager(config, ringBuffer);
    const haClient = new HomeAssistantClient(config);
    server = new WsServer(config, roomManager, haClient, new DeviceRegistrySource(haClient));
    server.start();

    while (server.port === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    wsUrl = `ws://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await roomManager.destroy();
    ringBuffer.destroy();
  });

  it('room_id fora do formato: auth_error e conexão fechada com 4001', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(parseControlMessage(data.toString())));

    const token = computeAuthToken(config.wsAuthSecret, 'device-1');
    ws.send(
      serializeControlMessage(
        // Hífen não é aceito pelo ROOM_ID_PATTERN (mesmo vocabulário do
        // area_id do HA: minúsculas, dígitos e underscore).
        createEnvelope('auth', 'sala-invalida', { device_id: 'device-1', token }),
      ),
    );

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    assert.equal(closeCode, 4001);
    assert.equal(messages.length, 1);
    const authError = messages[0] as { type: string; reason?: string };
    assert.equal(authError.type, 'auth_error');
    assert.match(authError.reason ?? '', /room_id/);
  });

  it('room_id válido: autentica normalmente (não é falso positivo do novo padrão)', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const token = computeAuthToken(config.wsAuthSecret, 'device-1');
    ws.send(
      serializeControlMessage(
        createEnvelope('auth', 'sala_de_estar', { device_id: 'device-1', token }),
      ),
    );

    const reply = await new Promise<{ type: string }>((resolve) => {
      ws.on('message', (data) => resolve(parseControlMessage(data.toString())!));
    });

    assert.equal(reply.type, 'auth_ok');
    ws.close();
  });

  it('frame acima do maxPayload é rejeitado pelo servidor (código 1009)', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const token = computeAuthToken(config.wsAuthSecret, 'device-1');
    ws.send(
      serializeControlMessage(
        createEnvelope('auth', 'sala_de_estar', { device_id: 'device-1', token }),
      ),
    );
    await new Promise<void>((resolve) => {
      ws.on('message', () => resolve());
    });

    // Bem acima dos 64KB configurados (maxPayload) e muito maior que qualquer
    // frame legítimo do contrato (640B de PCM + header).
    const oversized = Buffer.alloc(200 * 1024);
    ws.send(oversized);

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    assert.equal(closeCode, 1009);
  });
});
