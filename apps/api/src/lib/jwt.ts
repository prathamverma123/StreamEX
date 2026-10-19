import { createHash, randomBytes } from 'node:crypto';
import { SignOptions, sign, verify } from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';
import { UnauthorizedError } from '../lib/errors.js';

/**
 * JWT issuing / verification with kid-based key rotation.
 *
 * Two token kinds:
 *  - access  : short lived (JWT_ACCESS_TTL), carried in the Authorization
 *              header, claims = { sub, email, role, profileId? }
 *  - refresh : long lived (JWT_REFRESH_TTL); only its SHA-256 hash is stored
 *              in `sessions.token_hash`.
 *
 * Key rotation: tokens carry a `kid` header. The active secret signs new
 * tokens; during rotation the previous secret keeps verifying old tokens until
 * they expire (see docs/RUNBOOK.md § rotating JWT signing keys).
 */

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'USER' | 'ADMIN';
  profileId?: string;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string; // user id
  sid: string; // session row id
  fam: string; // token family id (rotation lineage)
  jti: string; // this token's unique id
  typ: 'refresh';
}

export type AccessVerifyResult = AccessTokenPayload & { iat: number; exp: number };
export type RefreshVerifyResult = RefreshTokenPayload & { iat: number; exp: number };

export interface JwtKeyring {
  active: { secret: string; kid: string };
  previous?: { secret: string; kid: string };
}

export function getKeyring(env = loadEnv()): JwtKeyring {
  const ring: JwtKeyring = {
    active: { secret: env.JWT_ACCESS_SECRET, kid: env.JWT_ACCESS_KID },
  };
  if (env.JWT_ACCESS_SECRET_PREVIOUS && env.JWT_PREVIOUS_KID) {
    ring.previous = { secret: env.JWT_ACCESS_SECRET_PREVIOUS, kid: env.JWT_PREVIOUS_KID };
  }
  return ring;
}

export function getRefreshKeyring(env = loadEnv()): JwtKeyring {
  const ring: JwtKeyring = {
    active: { secret: env.JWT_REFRESH_SECRET, kid: env.JWT_REFRESH_KID },
  };
  if (env.JWT_REFRESH_SECRET_PREVIOUS && env.JWT_PREVIOUS_KID) {
    ring.previous = { secret: env.JWT_REFRESH_SECRET_PREVIOUS, kid: env.JWT_PREVIOUS_KID };
  }
  return ring;
}

/** Parse "15m" / "30d" / "900s" / "12h" into seconds. */
export function ttlSeconds(ttl: string): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(ttl.trim());
  if (!match) return 900;
  const value = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      return 900;
  }
}

export function accessTokenTtlSeconds(env = loadEnv()): number {
  return ttlSeconds(env.JWT_ACCESS_TTL);
}

export function refreshTokenTtlSeconds(env = loadEnv()): number {
  return ttlSeconds(env.JWT_REFRESH_TTL);
}

/** Sign an access token with the active key + kid header. */
export function signAccessToken(payload: Omit<AccessTokenPayload, 'typ'>, env = loadEnv()): string {
  const ring = getKeyring(env);
  return sign(
    { ...payload, typ: 'access' },
    ring.active.secret,
    {
      expiresIn: env.JWT_ACCESS_TTL,
      algorithm: 'HS256',
      keyid: ring.active.kid,
    } as SignOptions,
  );
}

/** Sign a refresh token. */
export function signRefreshToken(
  payload: Omit<RefreshTokenPayload, 'typ' | 'jti'> & { jti?: string },
  env = loadEnv(),
): string {
  const ring = getRefreshKeyring(env);
  const jti = payload.jti ?? randomBytes(16).toString('hex');
  return sign(
    { ...payload, jti, typ: 'refresh' },
    ring.active.secret,
    {
      expiresIn: env.JWT_REFRESH_TTL,
      algorithm: 'HS256',
      keyid: ring.active.kid,
    } as SignOptions,
  );
}

/** Decode the `kid` header without verifying (used to pick the verify key). */
function decodeHeader(token: string): DecodedHeaderLike {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as DecodedHeaderLike;
  } catch {
    return {};
  }
}

interface DecodedHeaderLike {
  kid?: string;
}

function pickKey(ring: JwtKeyring, kid: string | undefined): string | null {
  if (!kid || kid === ring.active.kid) return ring.active.secret;
  if (ring.previous && kid === ring.previous.kid) return ring.previous.secret;
  return null;
}

/** Verify an access token against the active (and previous) keys. */
export function verifyAccessToken(token: string, env = loadEnv()): AccessVerifyResult {
  const ring = getKeyring(env);
  const kid = decodeHeader(token).kid;
  const secret = pickKey(ring, kid);
  if (!secret) {
    throw new UnauthorizedError('Unknown token signing key');
  }
  let decoded: unknown;
  try {
    decoded = verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new UnauthorizedError(
      err instanceof Error ? err.message : 'Invalid access token',
    );
  }
  if (typeof decoded === 'string') throw new UnauthorizedError('Malformed token payload');
  const payload = decoded as AccessVerifyResult;
  if (payload.typ !== 'access') throw new UnauthorizedError('Wrong token type');
  if (!payload.sub) throw new UnauthorizedError('Token missing subject');
  return payload;
}

/** Verify a refresh token against the active (and previous) keys. */
export function verifyRefreshToken(token: string, env = loadEnv()): RefreshVerifyResult {
  const ring = getRefreshKeyring(env);
  const kid = decodeHeader(token).kid;
  const secret = pickKey(ring, kid);
  if (!secret) throw new UnauthorizedError('Unknown token signing key');
  let decoded: unknown;
  try {
    decoded = verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new UnauthorizedError(err instanceof Error ? err.message : 'Invalid refresh token');
  }
  if (typeof decoded === 'string') throw new UnauthorizedError('Malformed token payload');
  const payload = decoded as RefreshVerifyResult;
  if (payload.typ !== 'refresh') throw new UnauthorizedError('Wrong token type');
  if (!payload.sub || !payload.sid || !payload.jti) {
    throw new UnauthorizedError('Token missing session binding');
  }
  return payload;
}

/** SHA-256 hex of a raw token — what goes into sessions.token_hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Fresh opaque token for password-reset links (raw value goes in the email). */
export function generateOpaqueToken(bytes = 32): { raw: string; hash: string } {
  const raw = randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}
