import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';

/**
 * Redis connection factory.
 *
 * Two roles:
 *  - app connections (queues, pub/sub fan-out, rate limiter store) — ioredis
 *    default behaviour, commands allowed.
 *  - subscriber connections — a SEPARATE dedicated connection because Redis
 *    puts a subscriber connection into subscribe mode where commands error.
 */

let cachedApp: Redis | null = null;
const cachedSubscribers = new Map<string, Redis>();

export function getRedis(): Redis {
  if (cachedApp) return cachedApp;
  cachedApp = new Redis(loadEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });
  cachedApp.on('error', (err) => {
    // Swallow but log — the rest of the app degrades gracefully without Redis.
    // eslint-disable-next-line no-console
    console.error('[redis] connection error:', err.message);
  });
  return cachedApp;
}

export function getSubscriber(name: string): Redis {
  const existing = cachedSubscribers.get(name);
  if (existing) return existing;
  const sub = new Redis(loadEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  sub.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[redis:${name}] subscriber error:`, err.message);
  });
  cachedSubscribers.set(name, sub);
  return sub;
}

export async function closeRedis(): Promise<void> {
  if (cachedApp) {
    await cachedApp.quit().catch(() => undefined);
    cachedApp = null;
  }
  for (const [name, sub] of cachedSubscribers) {
    await sub.quit().catch(() => undefined);
    cachedSubscribers.delete(name);
  }
}

/** Test helper. */
export function setRedisForTests(redis: Redis | null): void {
  cachedApp = redis;
}
