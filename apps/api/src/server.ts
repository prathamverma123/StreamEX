import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { getLogger, initLogger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { resetPrisma } from './lib/prisma.js';
import { closeQueues } from './queues/producer.js';

/**
 * API bootstrap: HTTP server + Socket.io + graceful shutdown.
 *
 * Startup order: env → logger → express → http server → socket.io → listen.
 * Shutdown order (SIGTERM/SIGINT): stop accepting connections → close socket
 * server → close BullMQ producers → close Redis → disconnect Prisma.
 */

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  initLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY, env: env.NODE_ENV });
  const log = getLogger();

  const app = createApp();
  const httpServer = createServer(app);

  // Socket.io (imported lazily so tests that never touch realtime skip it).
  let io: Awaited<ReturnType<typeof import('./realtime/socket.js').createSocketServer>> | null =
    null;
  try {
    const { createSocketServer } = await import('./realtime/socket.js');
    io = createSocketServer(httpServer);
    log.info('socket.io attached');
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'socket.io failed to attach — continuing without realtime',
    );
  }

  const server = httpServer.listen(env.PORT, () => {
    log.info(`streamex-api listening on :${env.PORT} [${env.NODE_ENV}]`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'graceful shutdown starting');
    // Stop accepting new connections, give in-flight requests 10s.
    server.close();
    const timer = setTimeout(() => process.exit(0), 10_000);
    timer.unref();
    try {
      await new Promise<void>((resolve) => {
        io?.close(() => resolve());
        if (!io) resolve();
      });
      await closeQueues();
      await closeRedis();
      await resetPrisma();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'error during shutdown');
    }
    clearTimeout(timer);
    log.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.stack ?? err.message }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

void bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to start streamex-api', err);
  process.exit(1);
});
