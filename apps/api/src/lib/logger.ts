import pino from 'pino';

/**
 * Structured logging with Pino.
 *
 * - Request-scoped child loggers are created by middleware/requestId.ts, which
 *   binds { requestId, userId, profileId } so every log line from a request is
 *   traceable.
 * - In dev (and test) logs are pretty-printed; in production they are newline
 *   delimited JSON ready for Loki / CloudWatch / Datadog ingestion.
 */

export type LogLevel =
  | 'fatal'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'
  | 'silent';

let rootLogger: pino.Logger | null = null;

export function initLogger(opts: {
  level: LogLevel;
  pretty: boolean;
  env: string;
}): pino.Logger {
  if (rootLogger) return rootLogger;
  const usePretty = opts.pretty && opts.env !== 'production';
  rootLogger = pino({
    level: opts.level,
    base: { service: 'streamex-api', env: opts.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
              singleLine: true,
            },
          },
        }
      : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'passwordHash',
        'token',
        'refreshToken',
        'accessToken',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.refreshToken',
        '*.accessToken',
      ],
      censor: '[REDACTED]',
    },
  });
  return rootLogger;
}

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    // Lazy default — used by tests and scripts that skip initLogger.
    rootLogger = pino({ level: 'silent' });
  }
  return rootLogger;
}

/** Create a child logger bound to request context fields. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
