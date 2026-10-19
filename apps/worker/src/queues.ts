import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import Redis from 'ioredis';
import { loadWorkerEnv } from './config/env.js';

/**
 * Queue wiring for the worker process.
 *
 * - `transcode`       : the main job queue; the Worker consumes it.
 * - `transcode:dlq`   : the dead-letter queue. BullMQ keeps failed jobs in the
 *                       main queue by default; we MOVE them to the DLQ after
 *                       the final attempt so operators can inspect/requeue.
 *
 * A single ioredis connection is shared as the queue connection; the Worker
 * gets its own (BullMQ requires a blocking connection).
 */

export interface TranscodeJobData {
  assetId: string;
  sourceKey: string;
  filename?: string;
  attempts?: number;
}

let sharedConnection: Redis | null = null;

export function redisConnection(): ConnectionOptions {
  if (!sharedConnection) {
    sharedConnection = new Redis(loadWorkerEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy(times) {
        return Math.min(times * 200, 2000);
      },
    });
    sharedConnection.on('error', () => undefined);
  }
  return sharedConnection as unknown as ConnectionOptions;
}

export function transcodeQueue(): Queue<TranscodeJobData> {
  const env = loadWorkerEnv();
  return new Queue<TranscodeJobData>(env.QUEUE_NAME_TRANSCODE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: env.TRANSCODE_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    },
  });
}

export function deadLetterQueue(): Queue<TranscodeJobData> {
  const env = loadWorkerEnv();
  return new Queue<TranscodeJobData>(env.QUEUE_NAME_TRANSCODE_DLQ, {
    connection: redisConnection(),
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: false },
  });
}

export interface WorkerHandle {
  worker: Worker<TranscodeJobData>;
  close(): Promise<void>;
}

export function startWorker(
  processor: (job: Job<TranscodeJobData>) => Promise<void>,
): WorkerHandle {
  const env = loadWorkerEnv();
  const worker = new Worker<TranscodeJobData>(env.QUEUE_NAME_TRANSCODE, processor, {
    connection: redisConnection(),
    concurrency: env.TRANSCODE_CONCURRENCY,
    lockDuration: env.WORKER_LOCK_DURATION_MS,
    stalledInterval: env.WORKER_STALLED_INTERVAL_MS,
    maxStalledCount: env.QUEUE_MAX_STALLED_COUNT,
  });
  return {
    worker,
    async close() {
      await worker.close();
    },
  };
}

export async function closeRedisConnection(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => undefined);
    sharedConnection = null;
  }
}
