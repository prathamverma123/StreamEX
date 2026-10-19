import { loadWorkerEnv } from './config/env.js';
import { getLogger } from './logger.js';
import { getPrisma, resetPrisma } from './prisma.js';
import {
  closeRedisConnection,
  deadLetterQueue,
  startWorker,
  type TranscodeJobData,
} from './queues.js';
import { processAsset } from './pipeline.js';

/**
 * Worker entrypoint.
 *
 * - Consumes the transcode queue with TRANSCODE_CONCURRENCY parallel jobs.
 * - On final failure the job is MOVED to the dead-letter queue and an admin
 *   notification event is published on the realtime channel.
 * - Graceful shutdown: stop taking jobs, finish in-flight, close Redis/Prisma.
 */

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = getLogger();

  log.info({ worker: env.WORKER_NAME, concurrency: env.TRANSCODE_CONCURRENCY }, 'worker starting');
  log.info('ffmpeg check: ' + (await checkFfmpeg() ? 'ok' : 'NOT FOUND'));

  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;

  const handle = startWorker(async (job) => {
    const data = job.data as TranscodeJobData;
    log.info({ assetId: data.assetId, jobId: job.id, attempt: job.attemptsMade + 1 }, 'transcode start');
    const outcome = await processAsset({ assetId: data.assetId, sourceKey: data.sourceKey });
    log.info(
      { assetId: data.assetId, rungs: outcome.rungs, sprite: outcome.spriteEntries },
      'transcode complete',
    );
  });

  handle.worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'job completed');
  });

  handle.worker.on('failed', async (job, err) => {
    if (!job) return;
    const attemptsMade = job.attemptsMade;
    const maxAttempts = env.TRANSCODE_MAX_ATTEMPTS;
    log.error(
      { jobId: job.id, assetId: job.data.assetId, attemptsMade, err: err.message },
      'job failed',
    );
    if (attemptsMade >= maxAttempts) {
      // Move to the DLQ + notify admins.
      try {
        const dlq = deadLetterQueue();
        await dlq.add('transcode-dead', job.data, {
          jobId: `dlq:asset:${job.data.assetId}`,
          attempts: 1,
        });
        log.warn({ jobId: job.id }, 'job moved to the dead-letter queue');
        // Admin notification over the realtime channel.
        const Redis = (await import('ioredis')).default;
        const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
        await publisher.connect();
        await publisher.publish(
          env.REALTIME_EVENT_CHANNEL,
          JSON.stringify({
            assetId: job.data.assetId,
            percent: 0,
            status: 'FAILED',
            message: `Transcode failed after ${maxAttempts} attempts: ${err.message}`,
            deadLettered: true,
            at: new Date().toISOString(),
          }),
        );
        await publisher.quit();
      } catch (dlqErr) {
        log.error(
          { err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr) },
          'failed to dead-letter the job',
        );
      }
    }
  });

  handle.worker.on('error', (err) => {
    log.error({ err: err.message }, 'worker error');
  });

  // ── graceful shutdown ──
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    const timer = setTimeout(() => process.exit(0), 15_000);
    timer.unref();
    try {
      await handle.close();
      await closeRedisConnection();
      await resetPrisma();
    } catch (err) {
      log.error({ err: String(err) }, 'error during worker shutdown');
    }
    clearTimeout(timer);
    log.info('worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection in worker');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.stack ?? err.message }, 'uncaught exception in worker — exiting');
    process.exit(1);
  });
}

async function checkFfmpeg(): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

void main().catch((err) => {
  console.error('fatal: worker failed to start', err);
  process.exit(1);
});
