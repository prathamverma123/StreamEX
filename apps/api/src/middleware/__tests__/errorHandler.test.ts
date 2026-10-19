import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  errorHandler,
  notFoundHandler,
} from '../errorHandler.js';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { getLogger } from '../../lib/logger.js';
import type { PrismaClient } from '../../generated/prisma/index.js';

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    headersSent: false,
    getHeader: jest.fn(),
    setHeader: jest.fn(),
  };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function mockReq(overrides: Partial<Request> = {}) {
  return {
    id: 'req-123',
    log: getLogger(),
    originalUrl: '/catalog/browse',
    path: '/catalog/browse',
    method: 'GET',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

const next: NextFunction = jest.fn();

describe('errorHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an AppError with its status, code and requestId', () => {
    const res = mockRes();
    errorHandler(new NotFoundError('Nope'), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'NOT_FOUND',
        message: 'Nope',
        requestId: 'req-123',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('includes details when present', () => {
    const res = mockRes();
    const err = new ValidationError('bad', [{ path: 'email', message: 'invalid' }]);
    errorHandler(err, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0]![0] as { error: { details: unknown } };
    expect(body.error.details).toEqual([{ path: 'email', message: 'invalid' }]);
  });

  it('renders ZodError as 400 with issue details', () => {
    const res = mockRes();
    const schema = z.object({ page: z.coerce.number().int().min(1) });
    const result = schema.safeParse({ page: '-1' });
    expect(result.success).toBe(false);
    errorHandler(result.error!, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0]![0] as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details[0]).toMatchObject({ path: 'page' });
  });

  it('maps Prisma P2002 unique violations to 409', () => {
    const res = mockRes();
    const prismaErr = Object.assign(new Error('duplicate'), {
      code: 'P2002',
      meta: { target: ['email'] },
      clientVersion: '6.0.0',
    });
    errorHandler(prismaErr, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0]![0] as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('email');
  });

  it('maps Prisma P2025 to 404', () => {
    const res = mockRes();
    const prismaErr = Object.assign(new Error('not found'), {
      code: 'P2025',
      clientVersion: '6.0.0',
    });
    errorHandler(prismaErr, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]![0] as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('renders unknown errors as opaque 500s with an errorId', () => {
    const res = mockRes();
    errorHandler(new Error('secret internals'), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0]![0] as {
      error: { code: string; errorId?: string; requestId: string };
    };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error.requestId).toBe('req-123');
  });

  it('defers to next() when headers were already sent', () => {
    const res = mockRes();
    res.headersSent = true;
    const err = new AppError('late', 400, 'BAD_REQUEST');
    errorHandler(err, mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to the root logger when req.log is absent', () => {
    const res = mockRes();
    errorHandler(
      new NotFoundError(),
      mockReq({ log: undefined } as unknown as Request),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('notFoundHandler', () => {
  it('returns a 404 envelope describing the unmatched route', () => {
    const res = mockRes();
    const req = mockReq({ method: 'POST', path: '/nope' });
    notFoundHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]![0] as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Route not found: POST /nope');
    expect(body.error.requestId).toBe('req-123');
  });
});

// Reference PrismaClient only to ensure the import path stays valid in tests.
type _P = PrismaClient;
