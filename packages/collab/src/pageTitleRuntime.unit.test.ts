import type { Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createPageTitleRuntime } from './pageTitleRuntime';

describe('page title runtime', () => {
  it('reverts an oversized collaborative title to the accepted title', () => {
    const runtime = createPageTitleRuntime({
      pool: {} as Pool,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      getHocuspocus: () => ({ documents: new Map() }) as unknown as Hocuspocus,
      blockDocument: vi.fn(),
    });
    const document = new Y.Doc();
    runtime.rememberLoaded('page-1', 'Accepted');
    document.getText('title').insert(0, 'x'.repeat(300));
    expect(runtime.ensureWithinLimit('page-1', document)).toBe(true);
    expect(document.getText('title').toString()).toBe('Accepted');
    document.destroy();
  });
});
