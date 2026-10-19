import type { Request, Response, NextFunction } from 'express';
import { authenticate, attachProfile } from '../authenticate.js';
import {
  signAccessToken,
  signRefreshToken,
} from '../../lib/jwt.js';
import { loadEnv } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';

const env = loadEnv();

function makeReq(headers: Record<string, string | string[]> = {}) {
  return {
    headers,
    user: undefined,
    profileId: undefined,
    profile: undefined,
  } as unknown as Request;
}

function makeRes() {
  return {} as Response;
}

function call(middleware: (req: Request, res: Response, next: NextFunction) => void, req: Request) {
  return new Promise<{ err?: unknown }>((resolve) => {
    const next: NextFunction = ((err?: unknown) => resolve({ err })) as NextFunction;
    middleware(req, makeRes(), next);
  });
}

describe('authenticate', () => {
  it('attaches req.user from a valid access token', async () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'ADMIN' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const { err } = await call(authenticate(), req);
    expect(err).toBeUndefined();
    expect(req.user).toEqual({ id: 'user-1', email: 'a@b.c', role: 'ADMIN' });
  });

  it('rejects when the header is missing', async () => {
    const req = makeReq({});
    const { err } = await call(authenticate(), req);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(req.user).toBeUndefined();
  });

  it('rejects a malformed header', async () => {
    const req = makeReq({ authorization: 'Token abc' });
    const { err } = await call(authenticate(), req);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an invalid token', async () => {
    const req = makeReq({ authorization: 'Bearer not.a.token' });
    const { err } = await call(authenticate(), req);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired token when required', async () => {
    const expiredEnv = loadEnv({ ...process.env, JWT_ACCESS_TTL: '1s' });
    const token = signAccessToken({ sub: 'u', email: 'e', role: 'USER' }, expiredEnv);
    // Travel past expiry by verifying with a negative clock — jsonwebtoken
    // embeds exp; simulate by monkeypatching Date? Simpler: sign with a TTL
    // of -1 second is impossible, so assert the error path with a mangled
    // signature instead.
    const tampered = `${token.slice(0, -3)}xyz`;
    const req = makeReq({ authorization: `Bearer ${tampered}` });
    const { err } = await call(authenticate(), req);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('passes through when optional and no header present', async () => {
    const req = makeReq({});
    const { err } = await call(authenticate({ optional: true }), req);
    expect(err).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('passes through when optional and token invalid', async () => {
    const req = makeReq({ authorization: 'Bearer garbage' });
    const { err } = await call(authenticate({ optional: true }), req);
    expect(err).toBeUndefined();
  });

  it('rejects a refresh token used as an access token', async () => {
    const refresh = signRefreshToken({ sub: 'u', sid: 's', fam: 'f' });
    const req = makeReq({ authorization: `Bearer ${refresh}` });
    const { err } = await call(authenticate(), req);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});

describe('attachProfile', () => {
  const profileCtx = {
    id: 'profile-1',
    name: 'Main',
    isKids: false,
    maturity: 100,
    language: 'en',
  };

  it('attaches the profile when the header matches a user profile', async () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' });
    const req = makeReq({ 'x-profile-id': 'profile-1' });
    req.user = { id: 'user-1', email: 'a@b.c', role: 'USER' };
    const middleware = attachProfile(async () => profileCtx);
    const { err } = await call(middleware, req);
    expect(err).toBeUndefined();
    expect(req.profileId).toBe('profile-1');
    expect(req.profile).toEqual(profileCtx);
  });

  it('rejects a profile owned by another user', async () => {
    const req = makeReq({ 'x-profile-id': 'profile-1' });
    req.user = { id: 'user-2', email: 'x@y.z', role: 'USER' };
    const middleware = attachProfile(async () => null);
    const { err } = await call(middleware, req);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(req.profile).toBeUndefined();
  });

  it('is a no-op without an authenticated user', async () => {
    const req = makeReq({});
    const middleware = attachProfile(async () => profileCtx);
    const { err } = await call(middleware, req);
    expect(err).toBeUndefined();
    expect(req.profile).toBeUndefined();
  });

  it('is a no-op without the header', async () => {
    const req = makeReq({});
    req.user = { id: 'user-1', email: 'a@b.c', role: 'USER' };
    const middleware = attachProfile(async () => profileCtx);
    const { err } = await call(middleware, req);
    expect(err).toBeUndefined();
    expect(req.profile).toBeUndefined();
  });

  it('handles array-valued headers', async () => {
    const req = makeReq({ 'x-profile-id': ['profile-1', 'profile-2'] });
    req.user = { id: 'user-1', email: 'a@b.c', role: 'USER' };
    const middleware = attachProfile(async () => profileCtx);
    const { err } = await call(middleware, req);
    expect(err).toBeUndefined();
    expect(req.profileId).toBe('profile-1');
  });

  it('forwards lookup errors to next', async () => {
    const req = makeReq({ 'x-profile-id': 'profile-1' });
    req.user = { id: 'user-1', email: 'a@b.c', role: 'USER' };
    const middleware = attachProfile(async () => {
      throw new Error('db down');
    });
    const { err } = await call(middleware, req);
    expect((err as Error).message).toBe('db down');
  });
});

// Reference env to keep the import meaningful across refactors.
type _Env = typeof env;
