import type { Request, Response, NextFunction } from 'express';
import { makeLimiter, authLimiter, globalLimiter } from '../rateLimit.js';
import { loadEnv } from '../../config/env.js';

/* ------------------------------------------------------------------ *
 * Minimal fake harness for express-rate-limit v7.
 *
 * v7 no longer exposes its options on the middleware function
 * (`middleware.options` is gone; only `getKey`/`resetKey` are public),
 * so these tests exercise real behavior: we invoke the middleware
 * against fake req/res objects and assert status codes, header sets
 * and next() calls.
 * ------------------------------------------------------------------ */

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  headersSent: boolean;
  setHeader: (k: string, v: string) => FakeRes;
  getHeader: (k: string) => string | undefined;
  removeHeader: (k: string) => void;
  status: (c: number) => FakeRes;
  send: (b?: unknown) => FakeRes;
  end: (b?: unknown) => FakeRes;
  json: (b: unknown) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = String(v);
      return res;
    },
    getHeader(k) {
      return res.headers[k.toLowerCase()];
    },
    removeHeader(k) {
      delete res.headers[k.toLowerCase()];
    },
    status(c) {
      res.statusCode = c;
      return res;
    },
    send(b) {
      res.body = b;
      res.headersSent = true;
      return res;
    },
    end(b) {
      res.body = b;
      res.headersSent = true;
      return res;
    },
    json(b) {
      res.body = b;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

interface FakeReq {
  ip: string;
  path: string;
  method: string;
  url: string;
  protocol: string;
  headers: Record<string, string | string[]>;
}

function makeReq(
  ip = '203.0.113.7',
  path = '/catalog/browse',
  headers: Record<string, string | string[]> = {},
): FakeReq {
  return { ip, path, method: 'GET', url: path, protocol: 'http', headers };
}

/** Invoke the limiter once; resolves when next() runs or the response is sent. */
function hit(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: FakeReq,
  res: FakeRes = makeRes(),
): Promise<{ res: FakeRes; nextCalled: boolean }> {
  return new Promise((resolve) => {
    let nextCalled = false;
    middleware(
      req as unknown as Request,
      res as unknown as Response,
      (() => {
        nextCalled = true;
        resolve({ res, nextCalled });
      }) as NextFunction,
    );
    // v7 writes the rejection via res.status().send() — resolve on next tick
    // in case neither callback path ran synchronously.
    setImmediate(() => resolve({ res, nextCalled }));
  });
}

describe('makeLimiter — behavior', () => {
  it('lets requests 1..max through, then 429s with Retry-After', async () => {
    const max = 3;
    const limiter = makeLimiter({
      windowMs: 60_000,
      max,
      message: 'slow down',
      name: 'test',
    });

    const results: { res: FakeRes; nextCalled: boolean }[] = [];
    for (let i = 0; i < max + 1; i++) {
      // same IP ⇒ same counter
      results.push(await hit(limiter, makeReq('198.51.100.9')));
    }

    // requests 1..max pass
    for (let i = 0; i < max; i++) {
      const { res, nextCalled } = results[i]!;
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.getHeader('RateLimit-Limit')).toBe(String(max));
      expect(res.getHeader('RateLimit-Remaining')).toBe(String(max - 1 - i));
    }
    expect(results[0]!.res.getHeader('RateLimit-Policy')).toBe(`${max};w=60`);

    // request max+1 is rejected
    const blocked = results[max]!;
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(Number(blocked.res.getHeader('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.res.getHeader('RateLimit-Remaining')).toBe('0');
    expect(blocked.res.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
  });

  it('does not set legacy X-RateLimit-* headers', async () => {
    const limiter = makeLimiter({ windowMs: 60_000, max: 5, message: 'x', name: 'test' });
    const { res } = await hit(limiter, makeReq());
    expect(res.getHeader('X-RateLimit-Limit')).toBeUndefined();
    expect(res.getHeader('X-RateLimit-Remaining')).toBeUndefined();
    expect(res.getHeader('X-RateLimit-Reset')).toBeUndefined();
  });

  it('skips healthcheck paths uncounted', async () => {
    const limiter = makeLimiter({ windowMs: 60_000, max: 1, message: 'x', name: 'test' });
    for (const path of ['/health', '/healthz', '/ready']) {
      const { res, nextCalled } = await hit(limiter, makeReq('192.0.2.1', path));
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
      // No rate-limit headers on skipped requests.
      expect(res.getHeader('RateLimit-Limit')).toBeUndefined();
    }
    // Even after 3 hits on health paths, the same IP still has its full
    // budget on a real endpoint.
    const { nextCalled } = await hit(limiter, makeReq('192.0.2.1', '/catalog/browse'));
    expect(nextCalled).toBe(true);
  });

  it('keys by the first X-Forwarded-For entry when present', async () => {
    const limiter = makeLimiter({ windowMs: 60_000, max: 1, message: 'x', name: 'test' });

    // First request from proxy-forwarded client A — allowed.
    const a1 = await hit(limiter, makeReq('10.0.0.1', '/x', { 'x-forwarded-for': '198.51.100.10, 10.0.0.1' }));
    expect(a1.res.statusCode).toBe(200);

    // Same request again — same forwarded key ⇒ blocked.
    const a2 = await hit(limiter, makeReq('10.0.0.1', '/x', { 'x-forwarded-for': '198.51.100.10, 10.0.0.1' }));
    expect(a2.res.statusCode).toBe(429);

    // A different forwarded client shares nothing with A even though the
    // direct socket IP is identical.
    const b1 = await hit(limiter, makeReq('10.0.0.1', '/x', { 'x-forwarded-for': '198.51.100.11, 10.0.0.1' }));
    expect(b1.res.statusCode).toBe(200);

    // Without the header, req.ip is used.
    const c1 = await hit(limiter, makeReq('203.0.113.99'));
    expect(c1.res.statusCode).toBe(200);
    const c2 = await hit(limiter, makeReq('203.0.113.99'));
    expect(c2.res.statusCode).toBe(429);
  });

  it('gives distinct IPs independent counters', async () => {
    const limiter = makeLimiter({ windowMs: 60_000, max: 2, message: 'x', name: 'test' });
    const ips = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];

    // Exhaust each IP's budget.
    for (const ip of ips) {
      await hit(limiter, makeReq(ip));
      const second = await hit(limiter, makeReq(ip));
      expect(second.res.statusCode).toBe(200);
      const third = await hit(limiter, makeReq(ip));
      expect(third.res.statusCode).toBe(429);
    }

    // Every IP reached 429 independently; none leaked into the others.
    for (const ip of ips) {
      const key = (await limiter.getKey!(ip)) as { totalHits: number } | undefined;
      expect(key).toBeDefined();
      expect(key!.totalHits).toBe(3);
    }
  });

  it('exposes resetKey/getKey as the public v7 API', async () => {
    const limiter = makeLimiter({ windowMs: 60_000, max: 1, message: 'x', name: 'test' });
    expect(typeof limiter.getKey).toBe('function');
    expect(typeof limiter.resetKey).toBe('function');

    await hit(limiter, makeReq('198.51.100.50'));

    const before = (await limiter.getKey!('198.51.100.50')) as { totalHits: number };
    expect(before.totalHits).toBe(1);

    limiter.resetKey!('198.51.100.50');

    const after = (await limiter.getKey!('198.51.100.50')) as { totalHits: number } | undefined;
    // MemoryStore resets by re-creating the entry; a fresh key has no hits.
    expect(after === undefined || after.totalHits === 0).toBe(true);

    // And the client is allowed again.
    const { res } = await hit(limiter, makeReq('198.51.100.50'));
    expect(res.statusCode).toBe(200);
  });
});

describe('presets', () => {
  it('authLimiter blocks after RATE_LIMIT_AUTH_MAX requests', async () => {
    const env = loadEnv();
    const limiter = authLimiter();

    for (let i = 0; i < env.RATE_LIMIT_AUTH_MAX; i++) {
      const { res, nextCalled } = await hit(limiter, makeReq('203.0.113.60', '/auth/login'));
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.getHeader('RateLimit-Limit')).toBe(String(env.RATE_LIMIT_AUTH_MAX));
    }
    const blocked = await hit(limiter, makeReq('203.0.113.60', '/auth/login'));
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('authentication'),
      },
    });
  });

  it('globalLimiter blocks after RATE_LIMIT_GLOBAL_MAX requests', async () => {
    const env = loadEnv();
    const limiter = globalLimiter();

    for (let i = 0; i < env.RATE_LIMIT_GLOBAL_MAX; i++) {
      const { res, nextCalled } = await hit(limiter, makeReq('203.0.113.61'));
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    }
    const blocked = await hit(limiter, makeReq('203.0.113.61'));
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('Slow down'),
      },
    });
  });

  it('both presets use the configured window', async () => {
    const env = loadEnv();
    const auth = await hit(authLimiter(), makeReq('203.0.113.62'));
    expect(auth.res.getHeader('RateLimit-Policy')).toBe(
      `${env.RATE_LIMIT_AUTH_MAX};w=${env.RATE_LIMIT_WINDOW_SECONDS}`,
    );
    const global = await hit(globalLimiter(), makeReq('203.0.113.63'));
    expect(global.res.getHeader('RateLimit-Policy')).toBe(
      `${env.RATE_LIMIT_GLOBAL_MAX};w=${env.RATE_LIMIT_WINDOW_SECONDS}`,
    );
  });

  it('presets skip healthchecks too', async () => {
    const auth = await hit(authLimiter(), makeReq('203.0.113.64', '/health'));
    expect(auth.nextCalled).toBe(true);
    expect(auth.res.statusCode).toBe(200);
    const global = await hit(globalLimiter(), makeReq('203.0.113.65', '/ready'));
    expect(global.nextCalled).toBe(true);
    expect(global.res.statusCode).toBe(200);
  });
});
