import pino from 'pino';
import type { AppConfig } from '../config/env.js';

let loggerInstance: pino.Logger | null = null;

export function createLogger(config: AppConfig): pino.Logger {
  const isDev = process.env.NODE_ENV !== 'production';

  loggerInstance = pino({
    level: config.logLevel,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    }),
  });

  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    throw new Error('Logger não inicializado. Chame createLogger() primeiro.');
  }
  return loggerInstance;
}

export interface LogContext {
  room_id?: string;
  device_id?: string;
  provider?: string;
  latency_ms?: number;
  event?: string;
  seq?: number;
}

export function logWithContext(context: LogContext, msg: string): void {
  getLogger().info(context, msg);
}
