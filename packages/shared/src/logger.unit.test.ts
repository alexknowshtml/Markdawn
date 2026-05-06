import { describe, expect, it } from 'vitest';
import {
  getApiLogger,
  getAppLogger,
  getAuthLogger,
  getCollabLogger,
  getDbLogger,
  getWebLogger,
  setupLogger,
} from './logger';

describe('setupLogger', () => {
  it('is idempotent', async () => {
    await expect(setupLogger()).resolves.not.toThrow();
    await expect(setupLogger()).resolves.not.toThrow();
  });
});

describe('get*Logger', () => {
  it('returns a defined logger for each domain', () => {
    expect(getApiLogger()).toBeDefined();
    expect(getDbLogger()).toBeDefined();
    expect(getAuthLogger()).toBeDefined();
    expect(getCollabLogger()).toBeDefined();
    expect(getWebLogger()).toBeDefined();
    expect(getAppLogger()).toBeDefined();
  });

  it('returns a logger with log methods', () => {
    const logger = getApiLogger();
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
