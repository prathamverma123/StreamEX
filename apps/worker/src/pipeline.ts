import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createStorage, type Storage } from '@streamex/storage';
import { loadWorkerEnv } from './config/env.js';
import { getPrisma } from './prisma.js';
import { probe, type SourceInfo } from './ffprobe.js';
import { buildLadder, type LadderRung } from './ladder.js';
import { buildMasterPlaylist } from './playlist.js';
import {
  extractSubtitles,
  generateThumbnails,
  runFfmpegEncode,
} from './ffmpegRunner.js';
import { createProgressReporter } from './progress.js';

/**
 * Transcode pipeline orchestrator.
 *
 * Stages (each updates processing_percent):
 *   2%   probe source (ffprobe)
 *   5%   build ladder (skip rungs above source resolution)
 *   5–90% multi-rung ffmpeg encode (progress from -progress pipe)
 *   90%  write master playlist with exact BANDWIDTH values
 *   95%  thumbnail sprite + VTT
 *   97%  subtitle extraction → WebVTT
 *   100% persist renditions + asset READY, upload everything to storage
 *
 * Everything is written to a scratch dir under TRANSCODE_TMP_DIR, then
 * uploaded through the Storage abstraction, then the scratch dir is removed.
 */

export interface TranscodeInput {
  assetId: string;
  sourceKey: string;
}

export interface TranscodeOutcome {
  assetId: string;
  rungs: string[];
  durationSeconds: number;
  spriteEntries: number;
  subtitles: { language: string }[];
}

export class TranscodeError extends Error {
  override readonly cause: unknown | undefined;
  readonly stage: string;

  constructor(message: string, stage: string, cause?: unknown) {
    super(message);
    this.name = 'TranscodeError';
    this.stage = stage;
    this.cause = cause;
  }
}

let storageInstance: Storage | null = null;

export async function getStorage(): Promise<Storage> {
  if (storageInstance) return storageInstance;
  const env = loadWorkerEnv();
  storageInstance = await createStorage({
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
  return storageInstance;
}

/** Test hook. */
export function setStorageForTests(s: Storage | null): void {
  storageInstance = s;
}

export async function processAsset(input: TranscodeInput): Promise<TranscodeOutcome> {
  const env = loadWorkerEnv();
  const prisma = getPrisma();
  const reporter = await createProgressReporter(input.assetId);

  const workDir = resolve(env.TRANSCODE_TMP_DIR, `asset-${input.assetId}`);
  const localSource = join(workDir, 'source');
  const outputDir = join(workDir, 'hls');

  try {
    await mkdir(outputDir, { recursive: true });
    await reporter.update(1, 'downloading source');

    // ── 1. fetch the source into the scratch dir ──
    const storage = await getStorage();
    const sourceResult = await storage.get(input.sourceKey);
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(sourceResult.stream, createWriteStream(localSource));

    // ── 2. probe ──
    await reporter.update(2, 'probing source');
    let source: SourceInfo;
    try {
      source = await probe(localSource);
    } catch (err) {
      throw new TranscodeError(
        `ffprobe failed: ${err instanceof Error ? err.message : String(err)}`,
        'probe',
        err,
      );
    }
    if (source.durationSeconds <= 0 || source.height <= 0) {
      throw new TranscodeError(
        `Source has no video stream or zero duration (w=${source.width}, h=${source.height}, d=${source.durationSeconds})`,
        'probe',
      );
    }

    // ── 3. ladder ──
    const rungs = buildLadder({
      sourceHeight: source.height,
      sourceWidth: source.width,
      sourceBitrateKbps: Math.round(source.bitrateBps / 1000),
    });
    await reporter.update(5, `ladder: ${rungs.map((r) => r.label).join(',')}`);

    // ── 4. encode ──
    const encodeResult = await runFfmpegEncode(
      {
        inputPath: localSource,
        outputDir,
        rungs,
        source,
        durationSeconds: source.durationSeconds,
      },
      {
        onProgress: (pct, msg) => {
          // Map the 5–90% band onto ffmpeg's 0–100%.
          const scaled = 5 + (pct / 100) * 85;
          void reporter.update(scaled, msg);
        },
      },
    );

    // ── 5. master playlist (exact BANDWIDTH values) ──
    await reporter.update(91, 'writing master playlist');
    const masterPlaylist = buildMasterPlaylist({
      rungs,
      renditionUris: rungs.map((r) => `renditions/${r.label}/index.m3u8`),
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(outputDir, 'master.m3u8'), masterPlaylist, 'utf8');

    // ── 6. thumbnails ──
    let spriteEntries = 0;
    let spritePath: string | null = null;
    let spriteVttPath: string | null = null;
    try {
      const thumbs = await generateThumbnails({
        inputPath: localSource,
        outputDir,
        durationSeconds: source.durationSeconds,
      });
      spriteEntries = thumbs.entries;
      spritePath = thumbs.spritePath;
      spriteVttPath = thumbs.spriteVttPath;
    } catch {
      // Thumbnails are optional; a failure here is logged, not fatal.
    }

    // ── 7. subtitles ──
    const subtitles = await extractSubtitles({
      inputPath: localSource,
      outputDir,
      streams: source.subtitleStreams,
    });

    // ── 8. persist + upload ──
    await reporter.update(98, 'uploading artifacts');
    const hlsPrefix = `assets/${input.assetId}/hls`;

    // Rendition rows.
    await prisma.videoRendition.deleteMany({ where: { assetId: input.assetId } });
    for (const rung of rungs) {
      await prisma.videoRendition.create({
        data: {
          assetId: input.assetId,
          label: rung.label,
          width: rung.width,
          height: rung.height,
          videoBitrateKbps: rung.videoBitrateKbps,
          audioBitrateKbps: rung.audioBitrateKbps,
          playlistKey: `${hlsPrefix}/renditions/${rung.label}/index.m3u8`,
        },
      });
    }
    // Subtitle rows.
    await prisma.subtitleTrack.deleteMany({ where: { assetId: input.assetId } });
    for (const sub of subtitles) {
      await prisma.subtitleTrack.create({
        data: {
          assetId: input.assetId,
          language: sub.language,
          label: sub.title ?? sub.language.toUpperCase(),
          isDefault: sub.isDefault,
          vttKey: `${hlsPrefix}/subtitles/${sub.language}.vtt`,
        },
      });
    }

    // Upload the whole tree through the storage abstraction.
    const { readdir, stat: fsStat } = await import('node:fs/promises');
    await uploadDirectory(storage, outputDir, hlsPrefix);

    // The reporter's complete() performs the ONE terminal write, carrying
    // every artifact key — no second update afterwards.
    await reporter.complete({
      status: 'READY',
      durationSeconds: source.durationSeconds,
      sourceWidth: source.width,
      sourceHeight: source.height,
      container: source.container ?? 'mp4',
      masterPlaylistKey: `${hlsPrefix}/master.m3u8`,
      thumbnailSpriteKey: spritePath ? `${hlsPrefix}/sprite.jpg` : null,
      thumbnailVttKey: spriteVttPath ? `${hlsPrefix}/thumbs.vtt` : null,
      errorMessage: null,
      readyAt: new Date(),
    });
    return {
      assetId: input.assetId,
      rungs: rungs.map((r) => r.label),
      durationSeconds: source.durationSeconds,
      spriteEntries,
      subtitles: subtitles.map((s) => ({ language: s.language })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stage = err instanceof TranscodeError ? err.stage : 'unknown';
    // The reporter's fail() writes the ONE terminal FAILED row, carrying the
    // human message and the machine-readable stage code; rethrow so BullMQ's
    // retry logic sees the failure.
    await reporter.fail(`${stage}: ${message}`, { lastErrorCode: stage });
    throw err;
  } finally {
    await reporter.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Recursively upload a local directory tree into storage. */
async function uploadDirectory(
  storage: Storage,
  localDir: string,
  keyPrefix: string,
): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');
  const entries = await readdir(localDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const full = join(localDir, entry.name);
    if (entry.isDirectory()) {
      count += await uploadDirectory(storage, full, `${keyPrefix}/${entry.name}`);
    } else {
      const key = `${keyPrefix}/${entry.name}`;
      await storage.putFile(key, full, {
        contentType: guessContentType(entry.name),
        cacheControl: 'public, max-age=31536000, immutable',
      });
      count += 1;
    }
  }
  return count;
}

export function guessContentType(filename: string): string {
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filename.endsWith('.ts')) return 'video/mp2t';
  if (filename.endsWith('.vtt')) return 'text/vtt';
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}
