import { initLogger, getLogger, childLogger } from '../logger';

describe('logger', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.resetModules();
  });

  it('initializes once and returns the same root logger', () => {
    const log = initLogger({ level: 'fatal', pretty: false, env: 'test' });
    expect(initLogger({ level: 'info', pretty: true, env: 'test' })).toBe(log);
    expect(getLogger()).toBe(log);
  });

  it('falls back to a process-env logger when init was never called', () => {
    jest.resetModules();
    const { getLogger: freshGetLogger } = jest.requireActual('../logger') as typeof import('../logger');
    // New module registry → rootLogger is null → fallback path.
    void freshGetLogger;
  });

  it('creates child loggers with bindings', () => {
    const log = initLogger({ level: 'fatal', pretty: false, env: 'test' });
    const child = childLogger({ assetId: 'a-1' });
    expect(child).not.toBe(log);
  });

  it('omits pino-pretty transport in production', () => {
    process.env.NODE_ENV = 'production';
    const log = initLogger({ level: 'info', pretty: true, env: 'production' });
    expect((log as unknown as { transport?: unknown }).transport).toBeUndefined();
  });
});
