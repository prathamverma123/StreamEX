import rateLimit from 'express-rate-limit';
import { loadEnv } from '../config/env.js';

/**
 * Rate limiting presets.
 *
 * - strict: auth endpoints (login/register/refresh/reset) — low ceiling,
 *   short window. Reads RATE_LIMIT_AUTH_MAX from env.
 * - relaxed: everything else — reads RATE_LIMIT_GLOBAL_MAX.
 *
 * Both use the client IP as the key. Behind nginx the API trusts
 * X-Forwarded-For because app.ts sets `trust proxy`.
 */

function makeLimiter(opts: { windowMs: number; max: number; message: string; name: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: opts.message } },
    keyGenerator: (req) => {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
      }
      return req.ip ?? 'unknown';
    },
    // Never rate-limit healthchecks / internal probes.
    skip: (req) => req.path === '/health' || req.path === '/healthz' || req.path === '/ready',
  });
}

export function authLimiter() {
  const env = loadEnv();
  return makeLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    max: env.RATE_LIMIT_AUTH_MAX,
    message: 'Too many authentication attempts. Try again later.',
    name: 'auth',
  });
}

export function globalLimiter() {
  const env = loadEnv();
  return makeLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    max: env.RATE_LIMIT_GLOBAL_MAX,
    message: 'Too many requests. Slow down.',
    name: 'global',
  });
}

export { makeLimiter };
