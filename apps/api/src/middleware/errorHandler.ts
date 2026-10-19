import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';
import { randomUUID } from 'node:crypto';

/**
 * Centralized error handler — the last middleware in the stack.
 *
 * Response envelope:
 *   { error: { code, message, details?, requestId } }
 *
 * - AppError → its own status + code.
 * - ZodError (thrown when a service forgot to wrap in ValidationError) → 400.
 * - Prisma known errors (P2002 unique violation, P2025 record not found) →
 *   409 / 404 so route code stays free of try/catch noise.
 * - Anything else → 500 with a fresh `errorId` that is logged with the stack.
 */

interface PrismaKnownError {
  code: string;
  meta?: { target?: string[] | string; cause?: unknown };
}

function isPrismaError(err: unknown): err is PrismaKnownError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const log = req.log ?? getLogger();

  // ── zod ──
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
        requestId: req.id,
      },
    });
    return;
  }

  // ── app errors ──
  if (err instanceof AppError) {
    if (err.isExpected) {
      log.warn({ err: err.message, code: err.code, path: req.originalUrl }, 'request failed');
    } else {
      log.error({ err: err.message, code: err.code, path: req.originalUrl }, 'request failed');
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        requestId: req.id,
      },
    });
    return;
  }

  // ── prisma ──
  if (isPrismaError(err)) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? err.meta!.target!.join(', ')
        : err.meta?.target ?? 'unknown';
      log.warn({ target }, 'unique constraint violation');
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: `Duplicate value for: ${target}`,
          details: { target },
          requestId: req.id,
        },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          requestId: req.id,
        },
      });
      return;
    }
  }

  // ── unknown ──
  const errorId = randomUUID();
  log.error(
    {
      errorId,
      path: req.originalUrl,
      method: req.method,
      err: err instanceof Error ? err.stack ?? err.message : String(err),
    },
    'unhandled error',
  );
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Internal server error',
      requestId: req.id,
      errorId,
    },
  });
}

/** 404 handler — anything that fell through the router. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
}
