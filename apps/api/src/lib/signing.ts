import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HLS URL signing.
 *
 * The playback module mints a short-lived token bound to:
 *   - the asset id
 *   - the profile id (so a URL cannot be shared across profiles)
 *   - an expiry timestamp
 *
 * Token format: base64url(payloadJson).base64url(hmacSha256(payload, secret))
 *
 * Because segments live under a path that contains the token
 * (`/hls/:token/segments/...`), the SAME token authorizes the manifest AND
 * every segment below it — no per-segment re-signing needed.
 */

export interface HlsTokenPayload {
  /** Asset id the token unlocks. */
  aid: string;
  /** Profile id that requested playback. */
  pid: string;
  /** Optional episode id when playing a series episode. */
  eid?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signHlsToken(
  payload: HlsTokenPayload,
  secret: string,
  _now = Date.now(),
): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const mac = b64urlEncode(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyHlsToken(
  token: string,
  secret: string,
  now = Date.now(),
): HlsTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Malformed token');
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let received: Buffer;
  try {
    received = Buffer.from(mac, 'base64url');
  } catch {
    throw new Error('Malformed token');
  }
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    throw new Error('Invalid signature');
  }
  let payload: HlsTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as HlsTokenPayload;
  } catch {
    throw new Error('Malformed payload');
  }
  if (!payload.aid || !payload.pid || !payload.exp) {
    throw new Error('Incomplete token payload');
  }
  if (payload.exp * 1000 <= now) {
    throw new Error('Token expired');
  }
  return payload;
}

/** Kebab-ish sanitize for URL path segments. */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
