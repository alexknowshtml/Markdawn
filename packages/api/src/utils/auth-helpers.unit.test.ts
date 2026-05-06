import { describe, expect, it } from 'vitest';
import { buildWorkspaceSlug, getPersonalWorkspaceName, slugify } from './auth-helpers';

describe('slugify', () => {
  it('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('trims whitespace', () => {
    expect(slugify('  spaced  ')).toBe('spaced');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('a@b#c')).toBe('a-b-c');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('getPersonalWorkspaceName', () => {
  it('uses first name from full name', () => {
    expect(getPersonalWorkspaceName('John Doe', 'john@example.com')).toBe("John's Workspace");
  });

  it('falls back to email prefix when name is missing', () => {
    expect(getPersonalWorkspaceName(null, 'jane@example.com')).toBe("jane's Workspace");
  });

  it('falls back to "Personal" when both are missing', () => {
    expect(getPersonalWorkspaceName(null, null)).toBe("Personal's Workspace");
  });

  it('handles empty string name', () => {
    expect(getPersonalWorkspaceName('', 'test@example.com')).toBe("test's Workspace");
  });
});

describe('buildWorkspaceSlug', () => {
  it('returns base slug when no collision', async () => {
    const pool = {
      query: async () => ({ rowCount: 0, rows: [] }),
    };
    const slug = await buildWorkspaceSlug('My Workspace', pool);
    expect(slug).toBe('my-workspace');
  });

  it('appends suffix on collision', async () => {
    let callCount = 0;
    const pool = {
      query: async () => {
        callCount += 1;
        return { rowCount: callCount === 1 ? 1 : 0, rows: [] };
      },
    };
    const slug = await buildWorkspaceSlug('My Workspace', pool);
    expect(slug).toMatch(/^my-workspace-[a-z0-9]{6}$/);
  });

  it('falls back to longer suffix after 5 attempts', async () => {
    const pool = {
      query: async () => ({ rowCount: 1, rows: [] }),
    };
    const slug = await buildWorkspaceSlug('My Workspace', pool);
    expect(slug).toMatch(/^my-workspace-[a-z0-9]{8}$/);
  });

  it('handles empty name', async () => {
    const pool = {
      query: async () => ({ rowCount: 0, rows: [] }),
    };
    const slug = await buildWorkspaceSlug('', pool);
    expect(slug).toBe('personal');
  });
});
