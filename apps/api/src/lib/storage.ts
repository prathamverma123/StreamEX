import { createStorage, type Storage } from '@streamex/storage';
import { loadEnv } from '../config/env.js';

/**
 * Storage singleton for the API process.
 *
 * Initialised lazily on first use so tests that never touch storage don't pay
 * the cost. Selection between local/S3 is driven by STORAGE_BACKEND.
 */

let storage: Storage | null = null;

export async function getStorage(): Promise<Storage> {
  if (storage) return storage;
  const env = loadEnv();
  storage = await createStorage({
    backend: env.STORAGE_BACKEND,
    localRoot: env.STORAGE_LOCAL_ROOT,
    cdnBaseUrl: env.CDN_BASE_URL,
    ...(env.STORAGE_BACKEND === 's3'
      ? {
          s3: {
            endpoint: env.S3_ENDPOINT || undefined,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            signedUrlTtlSeconds: env.S3_SIGNED_URL_TTL_SECONDS,
            usePresignedPlayback: env.S3_USE_PRESIGNED_PLAYBACK,
          },
        }
      : {}),
  });
  return storage;
}

/** Test helper — inject a mock storage. */
export function setStorageForTests(mock: Storage | null): void {
  storage = mock;
}

export function resetStorage(): void {
  storage = null;
}
