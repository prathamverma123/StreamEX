import { loadEnv, corsOrigins, resetEnvCache } from '../env.js';

describe('loadEnv', () => {
  afterEach(() => resetEnvCache());

  it('parses the test environment successfully', () => {
    const env = loadEnv();
    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(4000);
    expect(env.HLS_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(env.UPLOAD_MAX_BYTES).toBeGreaterThan(BigInt(0));
  });

  it('throws a descriptive error when a required secret is missing', () => {
    const probe = { ...process.env, JWT_ACCESS_SECRET: '' } as NodeJS.ProcessEnv;
    expect(() => loadEnv(probe)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('enforces the 32-char minimum on secrets', () => {
    const probe = { ...process.env, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv;
    expect(() => loadEnv(probe)).toThrow(/32 chars/);
  });

  it('rejects unknown NODE_ENV values', () => {
    const probe = { ...process.env, NODE_ENV: 'staging' } as NodeJS.ProcessEnv;
    expect(() => loadEnv(probe)).toThrow(/NODE_ENV/);
  });

  it('booleanish flags treat false/0/no/off as false', () => {
    const base = { ...process.env } as NodeJS.ProcessEnv;
    for (const value of ['false', '0', 'no', 'off']) {
      const env = loadEnv({ ...base, S3_FORCE_PATH_STYLE: value });
      expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    }
    const env = loadEnv({ ...base, S3_FORCE_PATH_STYLE: 'true' });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    // and the default when unset
    const defaulted = loadEnv({ ...base, S3_FORCE_PATH_STYLE: '' });
    expect(defaulted.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('integer() falls back to the default on blank values', () => {
    const env = loadEnv({ ...process.env, HLS_TOKEN_TTL_SECONDS: '' } as NodeJS.ProcessEnv);
    expect(env.HLS_TOKEN_TTL_SECONDS).toBe(3600);
  });

  it('memoizes against process.env but not explicit objects', () => {
    resetEnvCache();
    const first = loadEnv();
    const second = loadEnv();
    expect(first).toBe(second);
    const explicit = loadEnv({ ...process.env, PORT: '5000' } as NodeJS.ProcessEnv);
    expect(explicit.PORT).toBe(5000);
  });
});

describe('corsOrigins', () => {
  it('includes CORS_ORIGINS entries plus FRONTEND_URL, deduped', () => {
    const env = loadEnv({
      ...process.env,
      CORS_ORIGINS: 'http://a.test, http://b.test',
      FRONTEND_URL: 'http://a.test',
    } as NodeJS.ProcessEnv);
    const list = corsOrigins(env);
    expect(list.origins).toEqual(['http://a.test', 'http://b.test']);
    expect(list.test('http://a.test')).toBe(true);
    expect(list.test('http://b.test')).toBe(true);
    expect(list.test('http://evil.test')).toBe(false);
    expect(list.test(undefined)).toBe(false);
  });

  it('supports the wildcard entry', () => {
    const env = loadEnv({
      ...process.env,
      CORS_ORIGINS: '*',
      FRONTEND_URL: 'http://f.test',
    } as NodeJS.ProcessEnv);
    const list = corsOrigins(env);
    expect(list.test('http://anything.test')).toBe(true);
  });

  it('trims and drops empty entries', () => {
    const env = loadEnv({
      ...process.env,
      CORS_ORIGINS: ' , http://a.test ,',
      FRONTEND_URL: 'http://f.test',
    } as NodeJS.ProcessEnv);
    const list = corsOrigins(env);
    expect(list.origins).toEqual(['http://a.test', 'http://f.test']);
  });
});
