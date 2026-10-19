import type { z } from 'zod';

/**
 * Error hierarchy + JSON error envelope.
 *
 * Every error surfaced to a client goes through middleware/errorHandler.ts,
 * which maps AppError → HTTP status + machine-readable code. Unknown errors
 * become 500s with an opaque id that also lands in the logs.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNPROCESSABLE'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'
  | 'SERVICE_UNAVAILABLE';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Expected=true means "handled domain error" — logged at warn, not error. */
  readonly isExpected: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    options?: { details?: unknown; isExpected?: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
    this.isExpected = options?.isExpected ?? true;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', { details });
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', details?: unknown) {
    super(message, 429, 'RATE_LIMITED', { details });
  }
}

export class UnprocessableError extends AppError {
  constructor(message = 'Unprocessable entity', details?: unknown) {
    super(message, 422, 'UNPROCESSABLE', { details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', details?: unknown) {
    super(message, 413, 'PAYLOAD_TOO_LARGE', { details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE', { isExpected: false });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(message, 500, 'INTERNAL', { isExpected: false, cause });
  }
}

/** Zod issue → compact client-facing details array. */
export function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

