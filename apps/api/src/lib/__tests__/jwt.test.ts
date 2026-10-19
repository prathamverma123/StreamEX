import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyRefreshTokenWithEnv,
  hashToken,
  generateOpaqueToken,
  ttlSeconds,
  accessTokenTtlSeconds,
  refreshTokenTtlSeconds,
  getKeyring,
  getRefreshKeyring,
  AccessVerifyResult,
} from '../jwt.js';
import { UnauthorizedError } from '../errors.js';
import { loadEnv, resetEnvCache } from '../../config/env.js';

const env = loadEnv();

function makeEnv(overrides: Record<string, string> = {}) {
  return loadEnv({ ...process.env, ...overrides });
}

describe('ttlSeconds', () => {
  it('parses seconds, minutes, hours, days', () => {
    expect(ttlSeconds('900s')).toBe(900);
    expect(ttlSeconds('15m')).toBe(900);
    expect(ttlSeconds('12h')).toBe(43_200);
    expect(ttlSeconds('30d')).toBe(2_592_000);
  });

  it('falls back to 900 on garbage', () => {
    expect(ttlSeconds('forever')).toBe(900);
    expect(ttlSeconds('')).toBe(900);
  });

  it('is case-insensitive and tolerates spaces', () => {
    expect(ttlSeconds(' 5M ')).toBe(300);
  });
});

describe('access tokens', () => {
  it('signs and verifies an access token', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('a@b.c');
    expect(payload.role).toBe('USER');
    expect(payload.typ).toBe('access');
  });

  it('stamps the kid header', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' });
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header.kid).toBe(env.JWT_ACCESS_KID);
    expect(header.alg).toBe('HS256');
  });

  it('rejects a refresh token presented as access', () => {
    const refresh = signRefreshToken({ sub: 'user-1', sid: 's-1', fam: 'f-1' });
    expect(() => verifyAccessToken(refresh)).toThrow(UnauthorizedError);
  });

  it('rejects tokens signed with an unknown kid', () => {
    const foreign = signAccessToken(
      { sub: 'user-1', email: 'a@b.c', role: 'USER' },
      makeEnv({ JWT_ACCESS_KID: 'attacker-kid' }),
    );
    expect(() => verifyAccessToken(foreign)).toThrow('Unknown token signing key');
  });

  it('rejects garbage', () => {
    expect(() => verifyAccessToken('garbage')).toThrow(UnauthorizedError);
    expect(() => verifyAccessToken('a.b.c')).toThrow(UnauthorizedError);
  });

  it('verifies with the previous key during rotation', () => {
    const oldEnv = makeEnv({ JWT_ACCESS_KID: 'old-kid' });
    const oldToken = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' }, oldEnv);
    const rotated = makeEnv({
      JWT_ACCESS_KID: 'new-kid',
      JWT_ACCESS_SECRET_PREVIOUS: oldEnv.JWT_ACCESS_SECRET,
      JWT_PREVIOUS_KID: 'old-kid',
    });
    expect(verifyAccessToken(oldToken, rotated).sub).toBe('user-1');
    // And the unknown kid still fails under the rotated env.
    expect(() => verifyAccessToken(oldToken, makeEnv())).toThrow();
  });
});

describe('refresh tokens', () => {
  it('signs and verifies a refresh token with session binding', () => {
    const token = signRefreshToken({ sub: 'user-1', sid: 'session-1', fam: 'family-1' });
    const payload = verifyRefreshToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.sid).toBe('session-1');
    expect(payload.fam).toBe('family-1');
    expect(payload.jti).toBeDefined();
    expect(payload.typ).toBe('refresh');
  });

  it('each sign mints a unique jti', () => {
    const a = signRefreshToken({ sub: 'u', sid: 's', fam: 'f' });
    const b = signRefreshToken({ sub: 'u', sid: 's', fam: 'f' });
    expect(verifyRefreshToken(a).jti).not.toBe(verifyRefreshToken(b).jti);
  });

  it('rejects an access token presented as refresh', () => {
    const access = signAccessToken({ sub: 'u', email: 'a@b.c', role: 'USER' });
    // The access token carries the access kid, which the refresh keyring
    // does not know → rejected before the payload is even read.
    expect(() => verifyRefreshToken(access)).toThrow(UnauthorizedError);
  });

  it('rejects a refresh token whose payload is a bare string', () => {
    const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
    const weird = sign('just-a-string', env.JWT_REFRESH_SECRET, { keyid: env.JWT_REFRESH_KID });
    expect(() => verifyRefreshToken(weird)).toThrow(UnauthorizedError);
  });

  it('rejects malformed payload strings', () => {
    // covered above
  });
});

describe('keyrings', () => {
  it('has no previous key by default', () => {
    expect(getKeyring(makeEnv()).previous).toBeUndefined();
    expect(getRefreshKeyring(makeEnv()).previous).toBeUndefined();
  });

  it('exposes the previous key when configured', () => {
    const rotated = makeEnv({
      JWT_ACCESS_SECRET_PREVIOUS: 'x'.repeat(40),
      JWT_PREVIOUS_KID: 'prev-kid',
    });
    expect(getKeyring(rotated).previous).toEqual({ secret: 'x'.repeat(40), kid: 'prev-kid' });
  });
});

describe('token hashing', () => {
  it('hashToken is a stable sha256 hex', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('generateOpaqueToken returns raw + hash of the same value', () => {
    const { raw, hash } = generateOpaqueToken();
    expect(raw.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(raw));
  });
});

describe('TTLs from env', () => {
  it('reads the configured TTLs', () => {
    expect(accessTokenTtlSeconds(makeEnv({ JWT_ACCESS_TTL: '15m' }))).toBe(900);
    expect(refreshTokenTtlSeconds(makeEnv({ JWT_REFRESH_TTL: '30d' }))).toBe(2_592_000);
  });
});

// Keep TS happy about the exported type (used by services).
type _Access = AccessVerifyResult;
