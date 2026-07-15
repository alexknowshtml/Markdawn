import { describe, expect, it } from 'vitest';
import { deriveCapabilities, type SharePermission } from './page';

describe('deriveCapabilities', () => {
  it.each([
    {
      role: 'no access',
      permission: null,
      expected: { canEdit: false, canComment: false, canDelete: false, canCopy: false },
    },
    {
      role: 'viewer',
      permission: 'view' as const,
      expected: { canEdit: false, canComment: false, canDelete: false, canCopy: true },
    },
    {
      role: 'editor',
      permission: 'edit' as const,
      expected: { canEdit: true, canComment: true, canDelete: false, canCopy: true },
    },
    {
      role: 'admin',
      permission: 'admin' as const,
      expected: { canEdit: true, canComment: true, canDelete: true, canCopy: true },
    },
  ] satisfies Array<{
    role: string;
    permission: SharePermission | null;
    expected: ReturnType<typeof deriveCapabilities>;
  }>)('derives the $role capability boundary', ({ permission, expected }) => {
    expect(deriveCapabilities(permission)).toEqual(expected);
  });

  it('gives an owner full capabilities regardless of an explicit permission', () => {
    expect(deriveCapabilities(null, true)).toEqual({
      canEdit: true,
      canComment: true,
      canDelete: true,
      canCopy: true,
    });
  });
});
