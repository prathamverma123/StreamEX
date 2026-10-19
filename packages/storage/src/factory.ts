import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalFileStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { Storage, StorageBackendName } from './types.js';

export interface StorageFactoryConfig {
  backend: StorageBackendName | (string & {});
  /** Local backend root directory. */
  localRoot: string;
  /** Public base URL for media delivery (nginx / CDN). */
  cdnBaseUrl?: string;
  /** S3 options — required when backend === 's3'. */
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    signedUrlTtlSeconds: number;
    usePresignedPlayback: boolean;
  };
}

/**
 * Build a Storage instance from configuration.
 *
 * Selection rule: `STORAGE_BACKEND=local | s3` (see root .env.example).
 * Unknown values fail fast at startup rather than silently defaulting.
 */
export async function createStorage(config: StorageFactoryConfig): Promise<Storage> {
  if (config.backend === 'local') {
    const root = resolve(config.localRoot);
    await mkdir(root, { recursive: true });
    return new LocalFileStorage(root, config.cdnBaseUrl ?? '');
  }
  if (config.backend === 's3') {
    if (!config.s3) {
      throw new Error('STORAGE_BACKEND=s3 requires S3_* configuration');
    }
    return new S3Storage({
      ...config.s3,
      cdnBaseUrl: config.cdnBaseUrl,
    });
  }
  throw new Error(`Unknown STORAGE_BACKEND: ${String(config.backend)}`);
}

/**
 * Build a Storage directly from a flat env map (process.env or a test fixture).
 * Synchronous — it does not create directories, so it is safe in unit tests.
 */
export function buildStorageFromEnvLike(env: Record<string, string | undefined>): Storage {
  const backend = String(env.STORAGE_BACKEND ?? 'local');
  const cdnBaseUrl = env.CDN_BASE_URL ?? '';
  if (backend === 's3') {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'streamex-media',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      signedUrlTtlSeconds: Number(env.S3_SIGNED_URL_TTL_SECONDS ?? 3600),
      usePresignedPlayback: (env.S3_USE_PRESIGNED_PLAYBACK ?? 'false') !== 'false',
      cdnBaseUrl,
    });
  }
  if (backend !== 'local') {
    throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
  }
  return new LocalFileStorage(resolve(env.STORAGE_LOCAL_ROOT ?? './storage'), cdnBaseUrl);
}
