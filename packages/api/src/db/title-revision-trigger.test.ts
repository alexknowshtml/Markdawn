import { describe, expect, it } from 'vitest';
import { createTestPage, createTestUser } from '../test-utils';
import { testQuery as query } from './testQuery';

async function readPage(pageId: string): Promise<{ title: string; title_revision: string }> {
  const result = await query<{ title: string; title_revision: string }>(
    'select title, title_revision::text as title_revision from pages where id = $1',
    [pageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected page row');
  return row;
}

describe('page title revision database invariant', () => {
  it('advances monotonically even when a writer omits or regresses the revision', async () => {
    const owner = await createTestUser();
    const page = await createTestPage(owner.id, { title: 'Original' });

    // This intentionally omits title_revision. The database, not a source
    // inventory convention, owns the invariant.
    await query('update pages set title = $1 where id = $2', ['Uninstrumented writer', page.id]);
    expect(await readPage(page.id)).toEqual({
      title: 'Uninstrumented writer',
      title_revision: '1',
    });

    // Existing instrumented writers must not be double-incremented.
    await query('update pages set title = $1, title_revision = title_revision + 1 where id = $2', [
      'Instrumented writer',
      page.id,
    ]);
    expect(await readPage(page.id)).toEqual({
      title: 'Instrumented writer',
      title_revision: '2',
    });

    // Neither a title change nor a revision-only update may move backwards.
    await query('update pages set title = $1, title_revision = 0 where id = $2', [
      'Regressing writer',
      page.id,
    ]);
    expect(await readPage(page.id)).toEqual({ title: 'Regressing writer', title_revision: '3' });
    await query('update pages set title_revision = 0 where id = $1', [page.id]);
    expect(await readPage(page.id)).toEqual({ title: 'Regressing writer', title_revision: '3' });
  });
});
