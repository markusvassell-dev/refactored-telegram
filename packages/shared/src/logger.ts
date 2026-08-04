import { redact } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  correlationId?: string;
  engagementId?: string;
  documentVersionId?: string;
  jobId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogContext;
  /** Injectable sink so tests can assert on output without touching stdout. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');
  const base = options.base ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  function emit(entryLevel: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const payload = {
      time: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...(redact({ ...base, ...context }) as Record<string, unknown>),
    };
    sink(JSON.stringify(payload));
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (context) => createLogger({ ...options, level, base: { ...base, ...context } }),
  };
}

export const logger = createLogger();
