import type { Hocuspocus } from '@hocuspocus/server';
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
  return createDocumentWriteCoordinator({
    pool: {} as Pool,
    logger,
    maxDocumentBytes,
    getHocuspocus: () => hocuspocus,
    access,
  });
}

describe('document write coordinator', () => {
  it('encapsulates document size estimates', () => {
    const coordinator = createCoordinator();
    coordinator.setDocumentSizeEstimate('page-1', 100);
    expect(coordinator.getDocumentSizeEstimate('page-1')).toBe(100);
    coordinator.resetDocumentState('page-1');
    expect(coordinator.getDocumentSizeEstimate('page-1')).toBe(0);
  });
});
