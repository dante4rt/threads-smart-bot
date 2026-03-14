// src/logger.ts — minimal structured logger

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

const minLevel: LogLevel =
  (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'critical') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info:  (message: string, meta?: Record<string, unknown>) => emit('info',  message, meta),
  warn:  (message: string, meta?: Record<string, unknown>) => emit('warn',  message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
  critical: (message: string, meta?: Record<string, unknown>) => emit('critical', message, meta),
};
