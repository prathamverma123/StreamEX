import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { childLogger } from '../lib/logger.js';

/**
 * Request-ID tracing.
 *
 * - Honours an inbound `X-Request-Id` (from nginx / the frontend) when present,
 *   otherwise mints a UUID.
 * - Attaches `req.id`, `req.log` (child logger) and echoes the id on the
 *   response header so clients can quote it in bug reports.
 */

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: import('pino').Logger;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[0-9a-zA-Z-]{8,64}$/;

export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    req.id =
      candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.log = childLogger({ requestId: req.id });
    next();
  };
}

/** Read the request id (for handlers that run outside express, e.g. tests). */
export function getRequestId(res: Response): string | undefined {
  const header = res.getHeader('X-Request-Id');
  return typeof header === 'string' ? header : undefined;
}
