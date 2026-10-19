import type { Request, Response, NextFunction } from 'express';
import { requestId, getRequestId } from '../requestId.js';

function makeReq(headers: Record<string, string | string[]> = {}) {
  return {
    headers,
    id: undefined,
    log: undefined,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    headers: {} as Record<string, string>,
    setHeader: jest.fn((k: string, v: string) => {
      res.headers[k] = v;
    }),
    getHeader: jest.fn((k: string) => res.headers[k]),
  };
  return res as unknown as Response & {
    headers: Record<string, string>;
    setHeader: jest.Mock;
  };
}

describe('requestId middleware', () => {
  it('mints a UUID and echoes it on the response header', () => {
    const req = makeReq();
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
  });

  it('honours a valid inbound X-Request-Id', () => {
    const inbound = 'trace-abcdef123456';
    const req = makeReq({ 'x-request-id': inbound });
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.id).toBe(inbound);
  });

  it('replaces a malformed inbound id', () => {
    const req = makeReq({ 'x-request-id': 'bad id with spaces !!' });
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.id).not.toBe('bad id with spaces !!');
    expect(req.id).toMatch(/-/);
  });

  it('rejects an over-long inbound id', () => {
    const long = 'x'.repeat(80);
    const req = makeReq({ 'x-request-id': long });
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.id).not.toBe(long);
  });

  it('attaches a request-scoped child logger', () => {
    const req = makeReq();
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.log).toBeDefined();
    expect(typeof req.log.info).toBe('function');
    // The child logger carries the requestId binding.
    expect((req.log.bindings() as Record<string, unknown>).requestId).toBe(req.id);
  });

  it('handles array-valued headers by using the first entry', () => {
    const req = makeReq({ 'x-request-id': ['trace-111122223333', 'trace-2'] });
    const res = makeRes();
    requestId()(req, res, (() => undefined) as NextFunction);
    expect(req.id).toBe('trace-111122223333');
  });
});

describe('getRequestId', () => {
  it('reads the id back from the response', () => {
    const res = makeRes();
    res.setHeader('X-Request-Id', 'abc-123');
    expect(getRequestId(res)).toBe('abc-123');
  });

  it('returns undefined when unset', () => {
    const res = makeRes();
    expect(getRequestId(res)).toBeUndefined();
  });
});
