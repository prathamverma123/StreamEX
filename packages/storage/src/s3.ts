import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  GetResult,
  PutOptions,
  SignUrlOptions,
  StatResult,
  Storage,
  StorageNotFoundError,
  normalizeKey,
} from './types.js';

/** @aws-sdk/types re-exports ReadableStream under several names across versions. */
type SdkBody = Readable | NodeWebReadableStream | (ReadableStream & {}) | undefined;

function isNoSuchKey(err: unknown): boolean {
  const anyErr = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (anyErr && typeof anyErr === 'object') {
    if (anyErr.name === 'NoSuchKey') return true;
    if (anyErr.Code === 'NoSuchKey') return true;
    if (anyErr.$metadata?.httpStatusCode === 404) return true;
  }
  return false;
}

function toSdkStream(body: SdkBody): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof body === 'object' && 'getReader' in body) {
    return Readable.fromWeb(body as NodeWebReadableStream);
  }
  return Readable.from([]);
}

/**
 * S3-compatible storage backend (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces).
 *
 * - `put` / `putFile` stream directly into the bucket.
 * - `signUrl` mints presigned GET URLs. When `cdnBaseUrl` is configured the backend
 *   assumes a CDN / nginx sits in front of the bucket and returns
 *   `${cdnBaseUrl}/${key}` instead, so both backends produce the same URL shape.
 */
export class S3Storage implements Storage {
  readonly backend = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cdnBaseUrl?: string;
  private readonly signedUrlTtlSeconds: number;
  private readonly usePresigned: boolean;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    cdnBaseUrl?: string;
    signedUrlTtlSeconds: number;
    usePresignedPlayback: boolean;
  }) {
    this.bucket = config.bucket;
    this.cdnBaseUrl = config.cdnBaseUrl?.replace(/\/+$/, '');
    this.signedUrlTtlSeconds = config.signedUrlTtlSeconds;
    this.usePresigned = config.usePresignedPlayback;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
      maxAttempts: 3,
    });
  }

  async put(key: string, stream: NodeJS.ReadableStream, options?: PutOptions): Promise<StatResult> {
    const k = normalizeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: k,
        Body: toSdkStream(stream as SdkBody),
        ContentType: options?.contentType ?? 'application/octet-stream',
        ...(options?.cacheControl ? { CacheControl: options.cacheControl } : {}),
        ...(options?.storageClass
          ? { StorageClass: options.storageClass as StorageClass }
          : {}),
      }),
    );
    return this.stat(k);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const k = normalizeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: k }));
      if (!res.Body) throw new StorageNotFoundError(k);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNoSuchKey(err)) throw new StorageNotFoundError(k);
      throw err;
    }
  }

  async get(key: string): Promise<GetResult> {
    const k = normalizeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: k }));
      if (!res.Body) throw new StorageNotFoundError(k);
      return {
        stream: toSdkStream(res.Body as SdkBody),
        length: res.ContentLength ?? undefined,
        contentType: res.ContentType,
        etag: res.ETag,
      };
    } catch (err) {
      if (isNoSuchKey(err)) throw new StorageNotFoundError(k);
      throw err;
    }
  }

  async stat(key: string): Promise<StatResult> {
    const k = normalizeKey(key);
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: k }),
      );
      return {
        size: res.ContentLength ?? 0,
        modifiedAt: res.LastModified ?? new Date(),
        etag: res.ETag,
        contentType: res.ContentType,
      };
    } catch (err) {
      if (isNoSuchKey(err)) throw new StorageNotFoundError(k);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (err) {
      if (err instanceof StorageNotFoundError) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const k = normalizeKey(key);
    try {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: [{ Key: k }] },
        }),
      );
    } catch (err) {
      if (isNoSuchKey(err)) return;
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const p = normalizeKey(prefix);
    let removed = 0;
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: p.length > 0 ? `${p}/` : '',
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (objects.length === 0) break;
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
      );
      removed += objects.length;
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
    return removed;
  }

  async signUrl(key: string, options: SignUrlOptions): Promise<string> {
    const k = normalizeKey(key);
    if (!this.usePresigned) {
      if (!this.cdnBaseUrl) {
        throw new Error('S3Storage requires cdnBaseUrl when S3_USE_PRESIGNED_PLAYBACK=false');
      }
      return `${this.cdnBaseUrl}/${k}`;
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: k,
      ...(options.downloadFilename
        ? { ResponseContentDisposition: `attachment; filename="${options.downloadFilename}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresIn });
  }

  async putFile(key: string, localPath: string, options?: PutOptions): Promise<StatResult> {
    return this.put(key, createReadStream(localPath), options);
  }

  localPath(_key: string): string | null {
    return null;
  }
}
