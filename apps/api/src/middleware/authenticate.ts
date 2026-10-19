import type { NextFunction, Request, Response } from 'express';
import { TokenExpiredError } from 'jsonwebtoken';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * JWT authentication middleware.
 *
 * Reads `Authorization: Bearer <accessToken>`, verifies signature + expiry,
 * and attaches `req.user = { id, email, role }` and `req.profileId` (from the
 * `X-Profile-Id` header, validated against the user's profiles below in
 * `attachProfile`).
 */

export interface AuthUser {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    profileId?: string;
    profile?: ProfileContext;
  }
}

export interface ProfileContext {
  id: string;
  name: string;
  isKids: boolean;
  maturity: number;
  language: string;
}

const BEARER = /^Bearer\s+(.+)$/i;

export function authenticate(options?: { optional?: boolean }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !BEARER.test(header)) {
      if (options?.optional) {
        next();
        return;
      }
      next(new UnauthorizedError('Missing or malformed Authorization header'));
      return;
    }
    const token = BEARER.exec(header)![1];
    try {
      const payload = verifyAccessToken(token);
      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
      next();
    } catch (err) {
      if (options?.optional && err instanceof TokenExpiredError) {
        next();
        return;
      }
      if (options?.optional) {
        next();
        return;
      }
      next(new UnauthorizedError(err instanceof Error ? err.message : 'Invalid token'));
    }
  };
}

// Re-exported for tests that construct expired tokens.
export { TokenExpiredError } from 'jsonwebtoken';

/** Attach the profile header without requiring it. */
export function attachProfile(getProfile: (userId: string, profileId: string) => Promise<ProfileContext | null>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next();
      return;
    }
    const headerProfileId = req.headers['x-profile-id'];
    const profileId = Array.isArray(headerProfileId) ? headerProfileId[0] : headerProfileId;
    if (!profileId) {
      next();
      return;
    }
    try {
      const profile = await getProfile(req.user.id, profileId);
      if (!profile) {
        next(new UnauthorizedError('Profile does not belong to this user'));
        return;
      }
      req.profileId = profile.id;
      req.profile = profile;
      next();
    } catch (err) {
      next(err);
    }
  };
}
