import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestError, NotFoundError, PayloadTooLargeError } from '../../lib/errors.js';
import { getPrisma } from '../../lib/prisma.js';
import { loadEnv } from '../../config/env.js';
import { getStorage } from '../../lib/storage.js';
import { enqueueTranscode } from '../../queues/producer.js';
import type { UploadCompleteInput, UploadInitInput } from '../admin/admin.schemas.js';

/**
 * Resumable chunked upload service.
 *
 * Protocol (three endpoints, see docs/API_REFERENCE.md):
 *   1. POST   /upload/init      → open an UploadSession, return uploadId + chunk size
 *   2. PATCH  /upload/:id        → append one chunk at a verified offset; the
 *                                  session row records receivedBytes/nextOffset
 *   3. POST   /upload/:id/complete → verify total size + optional etag, mark the
 *                                  asset READY-for-processing and enqueue the
 *                                  transcode job.
 *
 * Chunks are written to `uploads/:uploadId/part-:offset` in the storage backend,
 * and on complete are concatenated into the final `sourceKey`. This works on
 * both the local and S3 backends because everything goes through the Storage
 * interface — on S3 a real deployment would swap the concat for a multipart
 * upload completion (see docs/ARCHITECTURE.md § storage abstraction).
 */

export interface InitResult {
  uploadId: string;
  assetId: string;
  chunkSize: number;
  totalBytes: number;
  nextOffset: number;
}

export async function initUpload(userId: string, input: UploadInitInput): Promise<InitResult> {
  const env = loadEnv();
  if (input.totalBytes > Number(env.UPLOAD_MAX_BYTES)) {
    throw new PayloadTooLargeError(
      `File exceeds the maximum size of ${Number(env.UPLOAD_MAX_BYTES)} bytes`,
    );
  }
  const prisma = getPrisma();
  const asset = await prisma.videoAsset.findUnique({ where: { id: input.assetId } });
  if (!asset) throw new NotFoundError('Asset not found');
  if (asset.status !== 'UPLOADING') {
    throw new BadRequestError('Asset is not in the UPLOADING state');
  }
  const session = await prisma.uploadSession.create({
    data: {
      userId,
      assetId: input.assetId,
      filename: input.filename,
      totalBytes: BigInt(input.totalBytes),
      chunkSize: input.chunkSize,
      receivedBytes: 0n,
      nextOffset: 0n,
      status: 'ACTIVE',
    },
  });
  return {
    uploadId: session.id,
    assetId: input.assetId,
    chunkSize: input.chunkSize,
    totalBytes: input.totalBytes,
    nextOffset: 0,
  };
}

export interface AppendResult {
  receivedBytes: number;
  nextOffset: number;
  complete: boolean;
}

export async function appendChunk(
  userId: string,
  uploadId: string,
  offset: number,
  chunk: Buffer,
  etag?: string,
): Promise<AppendResult> {
  const prisma = getPrisma();
  const session = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session) throw new NotFoundError('Upload session not found');
  if (session.userId !== userId) throw new NotFoundError('Upload session not found');
  if (session.status !== 'ACTIVE') throw new BadRequestError('Upload session is closed');
  if (offset !== Number(session.nextOffset)) {
    throw new BadRequestError(
      `Offset mismatch: expected ${Number(session.nextOffset)}, got ${offset}`,
    );
  }
  const storage = await getStorage();
  const partKey = `uploads/${uploadId}/part-${offset}`;
  await storage.put(partKey, chunkToStream(chunk), { contentType: 'application/octet-stream' });
  const received = BigInt(offset) + BigInt(chunk.length);
  await prisma.uploadSession.update({
    where: { id: uploadId },
    data: { receivedBytes: received, nextOffset: received },
  });
  const total = Number(session.totalBytes);
  return {
    receivedBytes: Number(received),
    nextOffset: Number(received),
    complete: Number(received) >= total,
  };
}

export async function completeUpload(
  userId: string,
  uploadId: string,
  input: UploadCompleteInput,
): Promise<{ assetId: string; sourceKey: string; queued: boolean }> {
  const prisma = getPrisma();
  const session = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session) throw new NotFoundError('Upload session not found');
  if (session.userId !== userId) throw new NotFoundError('Upload session not found');
  if (session.status !== 'ACTIVE') throw new BadRequestError('Upload session is closed');
  const received = Number(session.receivedBytes);
  const total = Number(session.totalBytes);
  if (received !== total) {
    throw new BadRequestError(
      `Upload incomplete: received ${received} of ${total} bytes`,
    );
  }
  const storage = await getStorage();
  // Concatenate parts → final source key.
  const parts: Buffer[] = [];
  for (let offset = 0; offset < total; offset += session.chunkSize) {
    const partKey = `uploads/${uploadId}/part-${offset}`;
    parts.push(await storage.getBuffer(partKey));
  }
  const sourceKey = `sources/${session.assetId}/${sanitizeFilename(session.filename)}`;
  await storage.put(sourceKey, chunkToStream(Buffer.concat(parts)), {
    contentType: 'application/octet-stream',
  });
  // Clean up part objects.
  for (let offset = 0; offset < total; offset += session.chunkSize) {
    await storage.delete(`uploads/${uploadId}/part-${offset}`).catch(() => undefined);
  }
  const etag = input.etag ?? createHash('md5').update(Buffer.concat(parts)).digest('hex');
  await prisma.$transaction([
    prisma.uploadSession.update({
      where: { id: uploadId },
      data: { status: 'COMPLETED' },
    }),
    prisma.videoAsset.update({
      where: { id: session.assetId },
      data: {
        sourceKey,
        sourceEtag: etag,
        sourceSizeBytes: BigInt(total),
        status: 'PROCESSING',
        processingPercent: 0,
      },
    }),
  ]);
  await enqueueTranscode({ assetId: session.assetId, sourceKey });
  return { assetId: session.assetId, sourceKey, queued: true };
}

/** Resume info for a broken upload — client calls before re-uploading. */
export async function uploadStatus(userId: string, uploadId: string) {
  const prisma = getPrisma();
  const session = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session || session.userId !== userId) throw new NotFoundError('Upload session not found');
  return {
    uploadId: session.id,
    assetId: session.assetId,
    status: session.status,
    chunkSize: session.chunkSize,
    totalBytes: Number(session.totalBytes),
    receivedBytes: Number(session.receivedBytes),
    nextOffset: Number(session.nextOffset),
  };
}

function chunkToStream(buf: Buffer): NodeJS.ReadableStream {
  return Readable.from([buf]);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}
