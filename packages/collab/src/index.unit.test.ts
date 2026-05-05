import { describe, expect, it, vi } from 'vitest';

vi.mock('@hocuspocus/server', () => ({
  Server: class {
    listen() {}
  },
}));

vi.mock('@hocuspocus/extension-database', () => ({
  Database: class {},
}));

vi.mock('pg', () => ({
  Pool: class {
    query() {
      return Promise.resolve({ rows: [] });
    }
    on() {}
  },
}));

vi.mock('@markdawn/shared', async () => {
  const actual = await vi.importActual<typeof import('@markdawn/shared')>('@markdawn/shared');
  return {
    ...actual,
    setupLogger: vi.fn(),
    getCollabLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

describe('collab package entry point', () => {
  it('resolves the module graph without errors', async () => {
    const mod = await import('./index');
    expect(mod).toBeDefined();
  });
});
