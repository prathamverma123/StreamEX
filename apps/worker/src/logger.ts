import pino from 'pino';

/** Worker logger — same conventions as the API logger. */

let rootLogger: pino.Logger | null = null;

export function initLogger(opts: {
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  pretty: boolean;
  env: string;
}): pino.Logger {
  if (rootLogger) return rootLogger;
  const usePretty = opts.pretty && opts.env !== 'production';
  rootLogger = pino({
    level: opts.level,
    base: { service: 'streamex-worker', env: opts.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: true },
          },
        }
      : {}),
  });
  return rootLogger;
}

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  }
  return rootLogger;
}

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
