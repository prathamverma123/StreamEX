/**
 * StreamEX storage abstraction — common types.
 *
 * Two backends implement the `Storage` interface:
 *  - LocalFileStorage   (local filesystem, dev + single-node deployments)
 *  - S3Storage           (any S3-compatible object store: AWS S3, MinIO, R2, Spaces)
 *
 * Backends are selected via the STORAGE_BACKEND env flag (see root .env.example).
 */

export type StorageBackendName = 'local' | 's3';

export interface PutOptions {
  /** MIME type recorded with the object (S3 ContentType, or ignored locally). */
  contentType?: string;
  /**
   * Mark object as immutable cacheable media (S3 Cache-Control header,
   * or ignored by the local backend which relies on nginx for caching).
   */
  cacheControl?: string;
  /** S3 storage class (STANDARD, STANDARD_IA, ...). Local backend ignores it. */
  storageClass?: string;
}

export interface GetResult {
  stream: NodeJS.ReadableStream;
  /** Byte length when known (S3 always knows; local always knows). */
  length?: number;
  contentType?: string;
  etag?: string;
}

export interface StatResult {
  /** Byte length of the object. */
  size: number;
  /** Milliseconds since epoch of last modification. */
  modifiedAt: Date;
  etag?: string;
  contentType?: string;
}

export interface SignUrlOptions {
  /** Seconds the URL stays valid. Required. */
  expiresIn: number;
  /** Optional download filename (Content-Disposition). */
  downloadFilename?: string;
}

export interface Storage {
  readonly backend: StorageBackendName;

  /** Write a readable stream to `key` (creates parent dirs on the local backend). */
  put(key: string, stream: NodeJS.ReadableStream, options?: PutOptions): Promise<StatResult>;

  /** Read a file from disk into memory — small objects (playlists, VTT, sprites). */
  getBuffer(key: string): Promise<Buffer>;

  /** Get a readable stream of the object — large objects (source videos, segments). */
  get(key: string): Promise<GetResult>;

  /** Object metadata. Throws StorageNotFoundError when the key is absent. */
  stat(key: string): Promise<StatResult>;

  exists(key: string): Promise<boolean>;

  delete(key: string): Promise<void>;

  /** Delete every object under a prefix (a title's whole HLS tree, e.g. `titles/42/hls/`). */
  deletePrefix(prefix: string): Promise<number>;

  /**
   * A URL a client can GET the object from.
   *  - local backend: `${cdnBaseUrl}/${key}`
   *  - s3 backend: presigned URL (or public URL when cdnBaseUrl points at a CDN in front of S3)
   */
  signUrl(key: string, options: SignUrlOptions): Promise<string>;

  /**
   * Copy a local file into storage in chunks — used by the worker to move
   * ffmpeg output into the storage backend without buffering in memory.
   */
  putFile(key: string, localPath: string, options?: PutOptions): Promise<StatResult>;

  /** Absolute local path when the backend is `local` — enables ffmpeg direct writes. */
  localPath(key: string): string | null;
}

export class StorageError extends Error {
  override readonly cause: unknown | undefined;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(key: string) {
    super(`Object not found in storage: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** Normalize an object key: strip leading slashes, collapse duplicate slashes. */
export function normalizeKey(key: string): string {
  return key
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
}
