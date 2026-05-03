import { describe, expect, it } from 'vitest';

describe('shared', () => {
  it('exports types and utilities', async () => {
    const mod = await import('./index');
    expect(mod).toBeDefined();
  });
});
