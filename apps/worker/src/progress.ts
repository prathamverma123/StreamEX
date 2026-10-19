import { getPrisma } from './prisma.js';
import { redisConnection } from './queues.js';
import { loadWorkerEnv } from './config/env.js';
import type Redis from 'ioredis';

/**
 * Progress reporting.
 *
 * Two channels, updated on every progress callback:
 *  1. Postgres: video_assets.processing_percent (+ status/error message)
 *  2. Redis pub/sub: REALTIME_EVENT_CHANNEL → every API replica fans the event
 *     out to admin dashboards over Socket.io.
 *
 * DB writes are throttled to one per asset per 2% change so we don't hammer
 * Postgres with an update per ffmpeg progress line.
 */

export interface ProgressReporter {
  update(percent: number, message?: string): Promise<void>;
  fail(message: string, extra?: Record<string, unknown>): Promise<void>;
  complete(data?: TerminalData): Promise<void>;
  close(): Promise<void>;
}

/** Fields the pipeline merges into the terminal (READY) DB row. */
export interface TerminalData {
  status: 'READY';
  durationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  container: string;
  masterPlaylistKey: string;
  thumbnailSpriteKey: string | null;
  thumbnailVttKey: string | null;
  errorMessage: null;
  readyAt: Date;
  [key: string]: unknown;
}

interface ProgressState {
  lastWrittenPercent: number;
  lastWriteAt: number;
  publisher: Redis | null;
}

const DB_WRITE_MIN_DELTA = 2; // percent
const DB_WRITE_MIN_INTERVAL_MS = 2000;

export async function createProgressReporter(assetId: string): Promise<ProgressReporter> {
  const prisma = getPrisma();
  const env = loadWorkerEnv();
  const state: ProgressState = { lastWrittenPercent: -1, lastWriteAt: 0, publisher: null };

  const getPublisher = async (): Promise<Redis> => {
    if (!state.publisher) {
      const RedisCtor = (await import('ioredis')).default;
      state.publisher = new RedisCtor(env.REDIS_URL, { maxRetriesPerRequest: null });
      state.publisher.on('error', () => undefined);
    }
    return state.publisher;
  };

  const publish = async (event: Record<string, unknown>) => {
    try {
      const pub = await getPublisher();
      await pub.publish(env.REALTIME_EVENT_CHANNEL, JSON.stringify(event));
    } catch {
      // Realtime is best-effort; never fail a transcode over a pub/sub hiccup.
    }
  };

  const writeDb = async (
    percent: number,
    status: string,
    message?: string,
    extra?: Record<string, unknown>,
  ) => {
    await prisma.videoAsset.update({
      where: { id: assetId },
      data: {
        processingPercent: percent,
        status: status as 'PROCESSING' | 'READY' | 'FAILED',
        ...(message !== undefined ? { errorMessage: message } : {}),
        ...(extra ? extra : {}),
      },
    });
  };

  return {
    async update(percent, message) {
      const now = Date.now();
      const delta = Math.abs(percent - state.lastWrittenPercent);
      const intervalOk = now - state.lastWriteAt >= DB_WRITE_MIN_INTERVAL_MS;
      if (delta >= DB_WRITE_MIN_DELTA || (intervalOk && delta > 0)) {
        state.lastWrittenPercent = percent;
        state.lastWriteAt = now;
        await writeDb(percent, 'PROCESSING', message);
        await publish({
          assetId,
          percent,
          status: 'PROCESSING',
          message,
          at: new Date().toISOString(),
        });
      }
    },
    async fail(message, extra) {
      // The terminal FAILED row carries the full failure context in ONE write;
      // the pipeline does not write a second, conflicting row afterwards.
      await writeDb(state.lastWrittenPercent, 'FAILED', message, extra);
      await publish({
        assetId,
        percent: state.lastWrittenPercent,
        status: 'FAILED',
        message,
        at: new Date().toISOString(),
      });
    },
    async complete(data?: TerminalData) {
      // Merge the pipeline's terminal fields into the final READY write so
      // there is exactly ONE row flip and it carries every artifact key.
      const extra: Record<string, unknown> | undefined = data
        ? { ...data }
        : undefined;
      await writeDb(100, 'READY', undefined, extra);
      await publish({
        assetId,
        percent: 100,
        status: 'READY',
        at: new Date().toISOString(),
      });
    },
    async close() {
      if (state.publisher) {
        await state.publisher.quit().catch(() => undefined);
        state.publisher = null;
      }
    },
  };
}
