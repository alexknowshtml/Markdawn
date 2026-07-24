import type { Document } from '@hocuspocus/server';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPagePermissionTransition,
  applyPermissionSnapshot,
  applyPermissionState,
  type PermissionContext,
} from './permissionState';

function connection() {
  const sendStateless = vi.fn<(payload: string) => void>();
  const close = vi.fn();
  const active = {
    readOnly: true,
    sendStateless,
    close,
  } as unknown as ReturnType<Document['getConnections']>[number];
  return { active, close, sendStateless };
}

describe('permission state transitions', () => {
  it('updates permission, revision, read-only mode, and snapshot atomically', () => {
    const { active, sendStateless } = connection();
    const context: PermissionContext = { permission: 'view', accessRevision: '1' };

    expect(
      applyPermissionSnapshot(active, context, { permission: 'edit', accessRevision: '2' }),
    ).toMatchObject({ applied: true, previousPermission: 'view', previousReadOnly: true });
    expect(context).toEqual({ permission: 'edit', accessRevision: '2' });
    expect(active.readOnly).toBe(false);
    expect(JSON.parse(sendStateless.mock.calls[0]?.[0] as string)).toEqual({
      type: 'permission_snapshot',
      permission: 'edit',
      accessRevision: '2',
    });
  });

  it('ignores an older result without mutating connection state', () => {
    const { active, close, sendStateless } = connection();
    const context: PermissionContext = { permission: 'view', accessRevision: '2' };

    expect(
      applyPagePermissionTransition(active, context, { permission: 'edit', accessRevision: '1' }),
    ).toBe('ignored');
    expect(context).toEqual({ permission: 'view', accessRevision: '2' });
    expect(sendStateless).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('supports admission-time state updates without publishing transport messages', () => {
    const { active, sendStateless } = connection();
    const context: PermissionContext = { permission: 'view', accessRevision: '1' };

    const result = applyPermissionState(active, context, {
      permission: 'edit',
      accessRevision: '2',
    });

    expect(result.applied).toBe(true);
    expect(context).toEqual({ permission: 'edit', accessRevision: '2' });
    expect(active.readOnly).toBe(false);
    expect(sendStateless).not.toHaveBeenCalled();
  });

  it('fails closed and closes after an authoritative revoke', () => {
    const { active, close, sendStateless } = connection();
    active.readOnly = false;
    const context: PermissionContext = { permission: 'edit', accessRevision: '2' };

    expect(
      applyPagePermissionTransition(active, context, { permission: null, accessRevision: '3' }),
    ).toBe('revoked');
    expect(active.readOnly).toBe(true);
    expect(close).toHaveBeenCalledWith({ code: 4401, reason: 'Access revoked' });
    expect(sendStateless.mock.calls.map((call) => JSON.parse(call[0]).type)).toEqual([
      'permission_snapshot',
      'share_event',
    ]);
  });

  it('does not emit a transition event when authoritative permission is unchanged', () => {
    const { active, sendStateless } = connection();
    const context: PermissionContext = { permission: 'view', accessRevision: '3' };

    expect(
      applyPagePermissionTransition(active, context, { permission: 'view', accessRevision: '4' }),
    ).toBe('unchanged');
    expect(sendStateless).toHaveBeenCalledOnce();
  });
});
