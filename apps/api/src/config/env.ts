import { z } from 'zod';

/**
 * Central environment loading + validation.
 *
 * Every variable is documented in the root `.env.example`.
 * On invalid config the process exits with a clear message — fail fast
 * rather than serving requests with half-configured secrets.
 */

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
    });

const integer = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : Number(value)))
    .refine((value) => value === undefined || Number.isFinite(value), {
      message: 'must be a number',
    })
    .transform((value) => (value === undefined ? defaultValue : (value as number)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_KID: z.string().default('streamex-access-2026a'),
  JWT_REFRESH_KID: z.string().default('streamex-refresh-2026a'),
  JWT_ACCESS_SECRET_PREVIOUS: z.string().optional().default(''),
  JWT_REFRESH_SECRET_PREVIOUS: z.string().optional().default(''),
  JWT_PREVIOUS_KID: z.string().optional().default(''),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  HLS_SIGNING_SECRET: z.string().min(32, 'HLS_SIGNING_SECRET must be at least 32 chars'),
  HLS_TOKEN_TTL_SECONDS: integer(3600),
  HLS_SEGMENT_PREFIX: z.string().default('hls'),

  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('streamex-media'),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: booleanish(true),
  S3_SIGNED_URL_TTL_SECONDS: integer(3600),
  S3_USE_PRESIGNED_PLAYBACK: booleanish(false),

  UPLOAD_MAX_BYTES: z
    .string()
    .default('21474836480')
    .transform((v) => BigInt(v)),
  UPLOAD_CHUNK_SIZE: integer(8388608),
  UPLOAD_TTL_SECONDS: integer(86400),

  TRANSCODE_CONCURRENCY: integer(2),
  TRANSCODE_MAX_ATTEMPTS: integer(3),

  CDN_BASE_URL: z.string().default('http://localhost:8080'),
  API_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),

  RATE_LIMIT_WINDOW_SECONDS: integer(900),
  RATE_LIMIT_AUTH_MAX: integer(15),
  RATE_LIMIT_GLOBAL_MAX: integer(300),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: integer(1025),
  SMTP_SECURE: booleanish(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('StreamEX <no-reply@streamex.dev>'),
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),

  SOCKET_PATH: z.string().default('/socket.io'),
  REALTIME_EVENT_CHANNEL: z.string().default('events:transcode'),
  REALTIME_PROGRESS_CHANNEL: z.string().default('events:progress'),
  QUEUE_NAME_TRANSCODE: z.string().default('transcode'),
  QUEUE_NAME_TRANSCODE_DLQ: z.string().default('transcode:dlq'),
  QUEUE_NAME_EMAIL: z.string().default('email'),

  SWAGGER_ENABLED: booleanish(true),
  SWAGGER_PATH: z.string().default('/docs'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_PRETTY: booleanish(true),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/** Parse + validate process.env. Throws on the first invalid value. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv && source === process.env) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (source === process.env) cachedEnv = parsed.data;
  return parsed.data;
}

/** Test helper — clear the memoized env. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

export interface CorsOriginList {
  origins: string[];
  test(origin: string | undefined): boolean;
}

/** Parse CORS_ORIGINS into a matcher that also allows the frontend URL. */
export function corsOrigins(env: Env): CorsOriginList {
  const origins = Array.from(
    new Set(
      env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        .concat([env.FRONTEND_URL]),
    ),
  );
  return {
    origins,
    test(origin) {
      if (!origin) return false;
      if (origins.includes('*')) return true;
      return origins.includes(origin);
    },
  };
}
