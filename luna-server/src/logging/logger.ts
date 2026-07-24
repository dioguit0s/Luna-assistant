import pino from 'pino';
import type { AppConfig } from '../config/env.js';

let loggerInstance: pino.Logger | null = null;

const saoPauloFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// America/Sao_Paulo não observa mais horário de verão desde 2019, então o
// offset -03:00 é fixo.
function saoPauloTimestamp(): string {
  const now = new Date();
  const [date, time] = saoPauloFormatter.format(now).split(' ');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `,"time":"${date}T${time}.${ms}-03:00"`;
}

export function createLogger(config: AppConfig): pino.Logger {
  const isDev = process.env.NODE_ENV !== 'production';

  loggerInstance = pino({
    level: config.logLevel,
    timestamp: saoPauloTimestamp,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: false },
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
