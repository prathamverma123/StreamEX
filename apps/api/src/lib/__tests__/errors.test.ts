import {
  AppError,
  ValidationError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  UnprocessableError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  InternalError,
  zodDetails,
  ErrorCode,
} from '../errors.js';
import { z } from 'zod';

describe('AppError hierarchy', () => {
  it('maps every subclass to its HTTP status + code', () => {
    const cases: [AppError, number, ErrorCode][] = [
      [new ValidationError(), 400, 'VALIDATION_ERROR'],
      [new BadRequestError(), 400, 'BAD_REQUEST'],
      [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
      [new ForbiddenError(), 403, 'FORBIDDEN'],
      [new NotFoundError(), 404, 'NOT_FOUND'],
      [new ConflictError(), 409, 'CONFLICT'],
      [new RateLimitError(), 429, 'RATE_LIMITED'],
      [new UnprocessableError(), 422, 'UNPROCESSABLE'],
      [new PayloadTooLargeError(), 413, 'PAYLOAD_TOO_LARGE'],
      [new ServiceUnavailableError(), 503, 'SERVICE_UNAVAILABLE'],
      [new InternalError(), 500, 'INTERNAL'],
    ];
    for (const [err, status, code] of cases) {
      expect(err.statusCode).toBe(status);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('marks domain errors expected and infra errors unexpected', () => {
    expect(new NotFoundError().isExpected).toBe(true);
    expect(new InternalError().isExpected).toBe(false);
    expect(new ServiceUnavailableError().isExpected).toBe(false);
  });

  it('carries details and a cause', () => {
    const cause = new Error('boom');
    const err = new ValidationError('bad input', [{ field: 'email' }]);
    expect(err.details).toEqual([{ field: 'email' }]);

    const internal = new InternalError('kaboom', cause);
    expect((internal as { cause?: unknown }).cause).toBe(cause);
  });

  it('sets the class name on the instance', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ValidationError().name).toBe('ValidationError');
  });

  it('uses default messages when none provided', () => {
    expect(new ConflictError().message).toBe('Conflict');
    expect(new RateLimitError().message).toBe('Too many requests');
  });
});

describe('zodDetails', () => {
  it('flattens a zod error into path/message pairs', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().min(0),
    });
    const result = schema.safeParse({ email: 'nope', age: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const details = zodDetails(result.error);
      expect(details).toHaveLength(2);
      const paths = details.map((d) => d.path);
      expect(paths).toContain('email');
      expect(paths).toContain('age');
    }
  });

  it('uses (root) for top-level issues', () => {
    const schema = z.string().uuid();
    const result = schema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(zodDetails(result.error)[0]!.path).toBe('(root)');
    }
  });
});
