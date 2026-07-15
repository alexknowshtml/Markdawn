import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyPageMetaStatelessMessage, parsePageMetaStatelessMessage } from './usePageMeta';

describe('parsePageMetaStatelessMessage', () => {
  it('accepts valid workspace membership events', () => {
    expect(
      parsePageMetaStatelessMessage(
        JSON.stringify({
          type: 'workspace_membership_event',
          action: 'role_changed',
          ownerId: 'workspace-owner',
        }),
      ),
    ).toEqual({
      type: 'workspace_membership_event',
      action: 'role_changed',
      ownerId: 'workspace-owner',
    });
  });

  it('accepts folder deletion events', () => {
    expect(
      parsePageMetaStatelessMessage(
        JSON.stringify({
          type: 'entity_deleted',
          entityType: 'folder',
          entityId: 'folder-1',
        }),
      ),
    ).toEqual({ type: 'entity_deleted', entityType: 'folder', entityId: 'folder-1' });
  });

  it('removes deleted folder details and redirects the active folder route', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['folders', 'detail', 'folder-1'], { id: 'folder-1' });
    queryClient.setQueryData(['shares', 'entity', 'folder', 'folder-1'], { id: 'folder-1' });

    const shouldRedirect = applyPageMetaStatelessMessage(
      { type: 'entity_deleted', entityType: 'folder', entityId: 'folder-1' },
      queryClient,
      '/app/folder/deleted-folder-folder-1',
    );

    expect(shouldRedirect).toBe(true);
    expect(queryClient.getQueryData(['folders', 'detail', 'folder-1'])).toBeUndefined();
    expect(queryClient.getQueryData(['shares', 'entity', 'folder', 'folder-1'])).toBeUndefined();
  });

  it('ignores unrelated non-JSON provider messages', () => {
    expect(parsePageMetaStatelessMessage('provider-control-message')).toBeNull();
  });

  it('reports malformed Markdawn JSON instead of silently ignoring it', () => {
    expect(() => parsePageMetaStatelessMessage('{"type":"workspace_membership_event"')).toThrow(
      'Malformed stateless message',
    );
    expect(() =>
      parsePageMetaStatelessMessage(
        JSON.stringify({ type: 'workspace_membership_event', action: 'unknown' }),
      ),
    ).toThrow('Malformed workspace membership event');
    expect(() =>
      parsePageMetaStatelessMessage(
        JSON.stringify({ type: 'entity_deleted', entityType: 'folder' }),
      ),
    ).toThrow('Malformed folder deletion event');
  });
});
