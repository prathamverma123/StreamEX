import {
  signHlsToken,
  verifyHlsToken,
  safeSegment,
  sha256,
} from '../signing.js';
import { UnauthorizedError } from '../errors.js';
import { createHmac } from 'node:crypto';

const SECRET = 'test-hls-signing-secret-0123456789abcdef';

describe('signHlsToken / verifyHlsToken', () => {
  const payload = {
    aid: '99999999-9999-4999-8999-999999999999',
    pid: '33333333-3333-4333-8333-333333333333',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it('round-trips a valid token', () => {
    const token = signHlsToken(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const verified = verifyHlsToken(token, SECRET);
    expect(verified.aid).toBe(payload.aid);
    expect(verified.pid).toBe(payload.pid);
    expect(verified.exp).toBe(payload.exp);
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const token = signHlsToken(payload, SECRET);
    const [body, mac] = token.split('.');
    // Flip a byte in the payload body.
    const tamperedBody = Buffer.from(body, 'base64url').toString('utf8').replace('9', '8');
    const tampered = `${Buffer.from(tamperedBody).toString('base64url')}.${mac}`;
    expect(() => verifyHlsToken(tampered, SECRET)).toThrow('Invalid signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signHlsToken(payload, 'another-secret-that-is-long-enough!!');
    expect(() => verifyHlsToken(token, SECRET)).toThrow('Invalid signature');
  });

  it('rejects an expired token', () => {
    const expired = { ...payload, exp: Math.floor(Date.now() / 1000) - 10 };
    const token = signHlsToken(expired, SECRET);
    expect(() => verifyHlsToken(token, SECRET)).toThrow('Token expired');
  });

  it('accepts a token expiring in exactly one second', () => {
    const soon = { ...payload, exp: Math.floor(Date.now() / 1000) + 1 };
    const token = signHlsToken(soon, SECRET);
    // now = current ms; exp*1000 > now must hold.
    expect(() => verifyHlsToken(token, SECRET)).not.toThrow();
  });

  it('rejects garbage tokens', () => {
    expect(() => verifyHlsToken('not-a-token', SECRET)).toThrow('Malformed token');
    expect(() => verifyHlsToken('a.b.c', SECRET)).toThrow('Malformed token');
    expect(() => verifyHlsToken('!!!.???', SECRET)).toThrow(/Malformed|Invalid/);
  });

  it('rejects a payload missing required claims', () => {
    const incomplete = Buffer.from(
      JSON.stringify({ aid: 'x', exp: payload.exp }),
    ).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(incomplete).digest('base64url');
    expect(() => verifyHlsToken(`${incomplete}.${mac}`, SECRET)).toThrow(
      'Incomplete token payload',
    );
  });

  it('includes an optional episode id', () => {
    const withEpisode = {
      ...payload,
      eid: '77777777-7777-4777-8777-777777777777',
    };
    const token = signHlsToken(withEpisode, SECRET);
    expect(verifyHlsToken(token, SECRET).eid).toBe(withEpisode.eid);
  });
});

describe('safeSegment', () => {
  it('strips characters that are unsafe in URL paths', () => {
    expect(safeSegment('../../etc/passwd')).toBe('....etcpasswd');
    // Critically: no path separators survive, so traversal is impossible.
    expect(safeSegment('../../etc/passwd')).not.toMatch(/[/\\]/);
    expect(safeSegment('a/b\\c:d')).toBe('abcd');
    expect(safeSegment('asset-123_ABC.mp4')).toBe('asset-123_ABC.mp4');
  });
});

describe('sha256', () => {
  it('produces a hex digest', () => {
    expect(sha256('streamex')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('streamex')).toBe(sha256('streamex'));
    expect(sha256('other')).not.toBe(sha256('streamex'));
  });
});

describe('error classes (imported by signing consumers)', () => {
  it('exposes UnauthorizedError with the right status', () => {
    const err = new UnauthorizedError('nope');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.isExpected).toBe(true);
  });
});
