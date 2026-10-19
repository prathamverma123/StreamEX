import { loadWorkerEnv, resetWorkerEnvCache } from '../config/env';

describe('worker env', () => {
  afterEach(() => resetWorkerEnvCache());

  it('throws a per-field error listing every invalid variable', () => {
    expect(() => loadWorkerEnv({})).toThrow('DATABASE_URL');
    expect(() => loadWorkerEnv({ DATABASE_URL: '' })).toThrow('Invalid worker environment');
  });

  it('applies documented defaults', () => {
    const env = loadWorkerEnv({ DATABASE_URL: 'postgresql://x' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.STORAGE_BACKEND).toBe('local');
    expect(env.QUEUE_NAME_TRANSCODE).toBe('transcode');
    expect(env.QUEUE_NAME_TRANSCODE_DLQ).toBe('transcode:dlq');
    expect(env.TRANSCODE_MAX_ATTEMPTS).toBe(3);
    expect(env.REALTIME_EVENT_CHANNEL).toBe('events:transcode');
  });

  it('parses booleans leniently (false/0/no/off are falsey)', () => {
    const falsy = loadWorkerEnv({
      DATABASE_URL: 'x',
      S3_FORCE_PATH_STYLE: 'FALSE',
      TRANSCODE_ENABLE_4K: 'off',
      LOG_PRETTY: '0',
    });
    expect(falsy.S3_FORCE_PATH_STYLE).toBe(false);
    expect(falsy.TRANSCODE_ENABLE_4K).toBe(false);
    expect(falsy.LOG_PRETTY).toBe(false);

    const truthy = loadWorkerEnv({
      DATABASE_URL: 'x',
      S3_FORCE_PATH_STYLE: 'yes',
      TRANSCODE_ENABLE_4K: 'true',
    });
    expect(truthy.S3_FORCE_PATH_STYLE).toBe(true);
    expect(truthy.TRANSCODE_ENABLE_4K).toBe(true);
  });

  it('coerces integer strings and falls back on garbage', () => {
    const env = loadWorkerEnv({
      DATABASE_URL: 'x',
      TRANSCODE_HLS_SECONDS: '4',
      SPRITE_TILE_WIDTH: '12',
    });
    expect(env.TRANSCODE_HLS_SECONDS).toBe(4);
    expect(env.SPRITE_TILE_WIDTH).toBe(12);
  });

  it('does not cache explicitly-passed env objects', () => {
    const first = loadWorkerEnv({ DATABASE_URL: 'x', TRANSCODE_CONCURRENCY: '2' });
    const second = loadWorkerEnv({ DATABASE_URL: 'x', TRANSCODE_CONCURRENCY: '8' });
    expect(first.TRANSCODE_CONCURRENCY).toBe(2);
    expect(second.TRANSCODE_CONCURRENCY).toBe(8);
  });

  it('caches process.env until resetWorkerEnvCache is called', () => {
    const original = process.env.TRANSCODE_CONCURRENCY;
    const first = loadWorkerEnv(process.env);
    process.env.TRANSCODE_CONCURRENCY = '9';
    expect(loadWorkerEnv(process.env)).toBe(first); // cached instance
    resetWorkerEnvCache();
    const reparsed = loadWorkerEnv(process.env);
    expect(reparsed.TRANSCODE_CONCURRENCY).toBe(9);
    process.env.TRANSCODE_CONCURRENCY = original;
    resetWorkerEnvCache();
  });
});
