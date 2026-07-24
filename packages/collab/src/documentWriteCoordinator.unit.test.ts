import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentWriteCoordinator } from './documentWriteCoordinator';

function createCoordinator(maxDocumentBytes = 1024) {
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const hocuspocus = { documents: new Map() } as unknown as Hocuspocus;
  const access = {
    assertAnonymousPageAccess: vi.fn(),
    assertPageAccess: vi.fn(),
    lockDocumentAccessMutation: vi.fn(),
  };
  const coordinator = createDocumentWriteCoordinator({
    pool: {} as Pool,
    logger,
    maxDocumentBytes,
    getHocuspocus: () => hocuspocus,
    access,
  });
  return { coordinator, hocuspocus };
}

describe('document write coordinator', () => {
  it('encapsulates document size estimates', () => {
    const { coordinator } = createCoordinator();
    coordinator.setDocumentSizeEstimate('page-1', 100);
    expect(coordinator.getDocumentSizeEstimate('page-1')).toBe(100);
    coordinator.resetDocumentState('page-1');
    expect(coordinator.getDocumentSizeEstimate('page-1')).toBe(0);
  });

  it('does not retain a reload block for an inactive document', () => {
    const { coordinator, hocuspocus } = createCoordinator();
    const close = vi.fn();

    coordinator.blockDocumentForReload('page-1', 4500, 'Document reload required');
    expect(coordinator.isDocumentBlocked('page-1')).toBe(false);

    hocuspocus.documents.set('page-1', {
      getConnections: () => [{ close }],
    } as unknown as Document);
    coordinator.blockDocumentForReload('page-1', 4500, 'Document reload required');

    expect(close).toHaveBeenCalledWith({ code: 4500, reason: 'Document reload required' });
  });
});
