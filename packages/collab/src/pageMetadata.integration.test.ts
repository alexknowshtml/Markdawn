import { Document } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rebuildPageMetaDocument } from './pageMetadata';
import { createTestPage, createTestUser, getTestPool } from './test-utils';

describe('page metadata repository', () => {
  const pool = getTestPool();
  const logger = { debug: vi.fn() } as unknown as Logger;

  afterAll(async () => {
    await pool.end();
  });

  it('rebuilds page and permission indexes from canonical access state', async () => {
    const user = await createTestUser(pool);
    const page = await createTestPage(pool, user.id, 'Metadata boundary');
    const document = new Document(`page-meta:${user.id}`);

    await expect(rebuildPageMetaDocument(pool, user.id, document, logger)).resolves.toBe(true);
    expect(document.getMap('pageIndex').get(page.id)).toEqual(
      expect.objectContaining({ title: 'Metadata boundary', parentId: null }),
    );
    expect(document.getMap('accessPermissions').get(page.id)).toBe('edit');

    await expect(rebuildPageMetaDocument(pool, user.id, document, logger)).resolves.toBe(false);
    document.destroy();
  });
});
