import { z } from 'zod';

/**
 * Worker environment. Mirrors the API's config where the two services share
 * variables (Redis, DB, storage) and adds worker-specific knobs.
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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ── storage ──
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
  CDN_BASE_URL: z.string().default('http://localhost:8080'),

  // ── encoding ladder ──
  TRANSCODE_LADDER: z
    .string()
    .default('240:400,480:1000,720:2500,1080:5000,2160:15000'),
  TRANSCODE_VIDEO_CODEC: z.string().default('libx264'),
  TRANSCODE_AUDIO_CODEC: z.string().default('aac'),
  TRANSCODE_AUDIO_BITRATE_KBPS: integer(128),
  TRANSCODE_HLS_SECONDS: integer(2),
  TRANSCODE_KEYFRAME_SECONDS: integer(2),
  TRANSCODE_X264_PRESET: z.string().default('medium'),
  TRANSCODE_CONCURRENCY: integer(2),
  TRANSCODE_TMP_DIR: z.string().default('./work'),
  TRANSCODE_MAX_ATTEMPTS: integer(3),
  TRANSCODE_ENABLE_4K: booleanish(false),
  SPRITE_FRAME_INTERVAL_SECONDS: integer(10),
  SPRITE_TILE_WIDTH: integer(10),
  SPRITE_TILE_HEIGHT: integer(10),

  // ── queues ──
  QUEUE_NAME_TRANSCODE: z.string().default('transcode'),
  QUEUE_NAME_TRANSCODE_DLQ: z.string().default('transcode:dlq'),
  QUEUE_MAX_STALLED_COUNT: integer(2),
  WORKER_LOCK_DURATION_MS: integer(60000),
  WORKER_STALLED_INTERVAL_MS: integer(30000),
  WORKER_NAME: z.string().default(`streamex-worker-${process.pid}`),

  // ── realtime publishing ──
  REALTIME_EVENT_CHANNEL: z.string().default('events:transcode'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanish(true),
});

export type WorkerEnv = z.infer<typeof envSchema>;

let cached: WorkerEnv | null = null;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  if (cached && source === process.env) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment configuration:\n${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

export function resetWorkerEnvCache(): void {
  cached = null;
}
