import { asyncHandler } from '../asyncHandler.js';
import { requireAdmin } from '../requireAdmin.js';
import type { Request, Response, NextFunction } from 'express';

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('asyncHandler', () => {
  it('passes through synchronous return values', () => {
    const handler = jest.fn(() => 42);
    const wrapped = asyncHandler(handler);
    const req = {} as Request;
    const res = makeRes();
    const next: NextFunction = jest.fn();
    wrapped(req, res, next);
    expect(handler).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards rejections to next()', async () => {
    const boom = new Error('async failure');
    const wrapped = asyncHandler(async () => {
      throw boom;
    });
    const next: NextFunction = jest.fn();
    await wrapped({} as Request, makeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('supports handlers that call next themselves', async () => {
    const next: NextFunction = jest.fn();
    const wrapped = asyncHandler(async (_req, _res, n) => {
      (n as NextFunction)();
    });
    await wrapped({} as Request, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireAdmin', () => {
  it('rejects unauthenticated requests with 401', () => {
    const res = makeRes();
    requireAdmin()({} as Request, res, (() => undefined) as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  });

  it('rejects non-admin users with 403', () => {
    const req = { user: { id: 'u', email: 'e', role: 'USER' } } as unknown as Request;
    const res = makeRes();
    requireAdmin()(req, res, (() => undefined) as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'FORBIDDEN', message: 'Admin role required' },
    });
  });

  it('allows admins through', () => {
    const req = { user: { id: 'u', email: 'e', role: 'ADMIN' } } as unknown as Request;
    const res = makeRes();
    const next: NextFunction = jest.fn();
    requireAdmin()(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
