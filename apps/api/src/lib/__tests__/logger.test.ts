import { initLogger, getLogger, childLogger } from '../logger.js';

describe('logger', () => {
  it('initialises a root logger once and reuses it', () => {
    const a = initLogger({ level: 'silent', pretty: false, env: 'test' });
    const b = initLogger({ level: 'debug', pretty: false, env: 'test' });
    expect(a).toBe(b);
  });

  it('falls back to a silent logger without init', () => {
    // getLogger never throws even when initLogger was skipped.
    const log = getLogger();
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('creates child loggers with bindings', () => {
    const child = childLogger({ requestId: 'r-1' });
    expect((child.bindings() as Record<string, unknown>).requestId).toBe('r-1');
  });

  it('accepts all log levels without throwing', () => {
    const log = initLogger({ level: 'silent', pretty: false, env: 'test' });
    expect(() => {
      log.fatal('f');
      log.error('e');
      log.warn('w');
      log.info('i');
      log.debug('d');
      log.trace('t');
    }).not.toThrow();
  });
});
