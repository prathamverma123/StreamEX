import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { getRedis } from '../lib/redis.js';

/**
 * Queue producer side (API process).
 *
 * The worker imports `queues.ts` from @streamex/worker via a shared contract
 * file (see apps/worker/src/queues.ts) — both sides use identical queue
 * names and job data shapes, defined here once.
 */

export interface TranscodeJobData {
  assetId: string;
  sourceKey: string;
  /** Explicit override for tests / requeue with a different source. */
  filename?: string;
  attempts?: number;
}

let transcodeQueue: Queue<TranscodeJobData> | null = null;

export function getTranscodeQueue(): Queue<TranscodeJobData> {
  if (transcodeQueue) return transcodeQueue;
  const env = loadEnv();
  transcodeQueue = new Queue(env.QUEUE_NAME_TRANSCODE ?? 'transcode', {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: env.TRANSCODE_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    },
  });
  return transcodeQueue;
}

export async function enqueueTranscode(data: TranscodeJobData): Promise<string> {
  const queue = getTranscodeQueue();
  const job = await queue.add('transcode', data, { jobId: `asset:${data.assetId}` });
  return job.id ?? '';
}

/** Test helper — replace the queue with a mock. */
export function setTranscodeQueueForTests(q: Queue<TranscodeJobData> | null): void {
  transcodeQueue = q;
}

export async function closeQueues(): Promise<void> {
  if (transcodeQueue) {
    await transcodeQueue.close();
    transcodeQueue = null;
  }
}
