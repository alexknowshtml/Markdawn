import { describe, expect, it } from 'vitest';
import { deriveSidebarCapabilities } from './sidebarCapabilities';

describe('sidebar capabilities', () => {
  it.each([
    ['owned', 'view', true, true],
    ['workspace', 'admin', true, true],
    ['workspace', 'admin', false, false],
    ['shared', 'edit', true, false],
    ['alias', 'admin', false, false],
  ] as const)('derives move behavior for %s placement with %s permission', (placement, userPermission, sourceIsAdmin, canMove) => {
    expect(
      deriveSidebarCapabilities({
        entityType: 'folder',
        ownerId: 'owner',
        userPermission,
        currentUserId: 'viewer',
        placement,
        sourceIsAdmin,
      }).canMove,
    ).toBe(canMove);
  });

  it('allows child creation for folder editors but not page editors', () => {
    expect(
      deriveSidebarCapabilities({
        entityType: 'folder',
        userPermission: 'edit',
        placement: 'shared',
      }).canCreateChild,
    ).toBe(true);
    expect(
      deriveSidebarCapabilities({
        entityType: 'page',
        userPermission: 'edit',
        placement: 'shared',
      }).canCreateChild,
    ).toBe(false);
  });
});
