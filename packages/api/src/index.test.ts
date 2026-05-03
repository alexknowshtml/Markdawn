import { describe, expect, it, vi } from 'vitest';

vi.mock('@hono/node-server', () => ({
  serve: vi.fn(),
}));

vi.mock('@markdawn/shared', async () => {
  const actual = await vi.importActual<typeof import('@markdawn/shared')>('@markdawn/shared');
  return {
    ...actual,
    setupLogger: vi.fn(),
    getApiLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

describe('api package', () => {
  it('imports without crashing', async () => {
    const mod = await import('./index');
    expect(mod).toBeDefined();
  });
});
