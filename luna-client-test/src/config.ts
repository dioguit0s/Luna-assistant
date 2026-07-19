import { createHmac } from 'node:crypto';

export function computeAuthToken(secret: string, deviceId: string): string {
  return createHmac('sha256', secret).update(deviceId).digest('hex');
}

export interface ClientConfig {
  serverUrl: string;
  roomId: string;
  deviceId: string;
  authSecret: string;
  wavFile?: string;
  outputFile?: string;
  useMic?: boolean;
}

export function loadClientConfig(): ClientConfig {
  return {
    serverUrl: process.env.WS_SERVER_URL ?? 'ws://localhost:8080',
    roomId: process.env.ROOM_ID ?? 'sala_de_estar',
    deviceId: process.env.DEVICE_ID ?? 'test-client-001',
    authSecret: process.env.WS_AUTH_SECRET ?? 'dev-secret-change-me',
    wavFile: process.env.WAV_FILE,
    outputFile: process.env.OUTPUT_FILE,
  };
}

export function parseArgs(argv: string[]): Partial<ClientConfig> & { useMic?: boolean } {
  const result: Partial<ClientConfig> & { useMic?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--server' && next) result.serverUrl = next;
    if (arg === '--room-id' && next) result.roomId = next;
    if (arg === '--device-id' && next) result.deviceId = next;
    if (arg === '--wav' && next) result.wavFile = next;
    if (arg === '--output' && next) result.outputFile = next;
    if (arg === '--mic') result.useMic = true;
  }
  return result;
}
