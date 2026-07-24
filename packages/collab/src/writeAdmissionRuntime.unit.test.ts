import type { Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentWriteCoordinator } from './documentWriteCoordinator';
import { createConnectionLifecycle, type WriteAdmissionContext } from './hocuspocusV3Adapter';
import { createPageTitleRuntime } from './pageTitleRuntime';
import { createWriteAdmissionRuntime } from './writeAdmissionRuntime';

describe('write admission runtime', () => {
  it('records an immutable admission for a writable update', () => {
    const hocuspocus = { documents: new Map() } as unknown as Hocuspocus;
    const coordinator = createDocumentWriteCoordinator({
      pool: {} as Pool,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      maxDocumentBytes: 100,
      getHocuspocus: () => hocuspocus,
      access: {
        assertAnonymousPageAccess: vi.fn(),
        assertPageAccess: vi.fn(),
        lockDocumentAccessMutation: vi.fn(),
      },
    });
    const titles = createPageTitleRuntime({
      pool: {} as Pool,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      getHocuspocus: () => hocuspocus,
      blockDocument: coordinator.blockDocumentForReload,
    });
    const runtime = createWriteAdmissionRuntime({
      timeoutMs: 100,
      titles,
      blockDocument: coordinator.blockDocumentForReload,
    });
    const context: WriteAdmissionContext = { lifecycle: createConnectionLifecycle() };
    const admission = runtime.record(context, '7', '3', true, true);
    expect(admission).toEqual({ accessRevision: '7', titleRevision: '3', touchesTitle: true });
    expect(context.lifecycle.pendingWriteAdmissions).toEqual([admission]);
  });
});
