import { loadEnv } from '../config/env.js';
import { getRedis } from '../lib/redis.js';
import { getLogger } from '../lib/logger.js';

/**
 * Realtime publish helpers.
 *
 * The API publishes progress events to a Redis pub/sub channel; every API
 * replica subscribed to that channel fans the event out to its local
 * Socket.io clients through the Redis adapter (see realtime/socket.ts).
 *
 * The worker publishes transcode progress on the same mechanism using the
 * REALTIME_EVENT_CHANNEL.
 */

export interface TranscodeProgressEvent {
  assetId: string;
  percent: number;
  status: 'PROCESSING' | 'READY' | 'FAILED';
  message?: string;
  at: string;
}

export interface ProgressSyncEvent {
  titleId: string;
  episodeId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  percentWatched: number;
  updatedAt: string;
}

export async function publishTranscodeProgress(event: TranscodeProgressEvent): Promise<void> {
  const env = loadEnv();
  const redis = getRedis();
  await redis.publish(env.REALTIME_EVENT_CHANNEL, JSON.stringify(event));
}

export async function publishProgressSync(
  profileId: string,
  event: ProgressSyncEvent,
): Promise<void> {
  const env = loadEnv();
  const redis = getRedis();
  await redis.publish(
    env.REALTIME_PROGRESS_CHANNEL,
    JSON.stringify({ profileId, ...event }),
  );
  getLogger().debug({ profileId, titleId: event.titleId }, 'progress sync published');
}
