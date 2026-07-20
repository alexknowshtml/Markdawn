import type { Logger } from '@logtape/logtape';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { updateConnections } from './connectionIndex';
import { createTestPage, createTestUser, getTestPool } from './test-utils';

describe('connection index repository', () => {
  const pool = getTestPool();
  const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;

  afterAll(async () => {
    await pool.end();
  });

  it('replaces page connections through the batched persistence path', async () => {
    const owner = await createTestUser(pool);
    const source = await createTestPage(pool, owner.id, 'Source');
    const target = await createTestPage(pool, owner.id, 'Target');
    const document = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('path', 'Target');
    link.setAttribute('label', 'Target');
    link.setAttribute('targetId', target.id);
    paragraph.push([link]);
    document.getXmlFragment('prosemirror').push([paragraph]);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await updateConnections(
        client,
        source.id,
        Y.encodeStateAsUpdate(document),
        [{ userId: owner.id, isAnonymous: false }],
        logger,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
      document.destroy();
    }

    const result = await pool.query<{ target_id: string; occurrence_count: number }>(
      `select target_id, occurrence_count
       from connections where source_type = 'page' and source_id = $1`,
      [source.id],
    );
    expect(result.rows).toEqual([{ target_id: target.id, occurrence_count: 1 }]);
  });

  it('bounds each connection insertion batch', async () => {
    const owner = await createTestUser(pool);
    const source = await createTestPage(pool, owner.id, 'Many tags');
    const tags = Array.from({ length: 251 }, (_, index) => `tag-${index}`);
    await pool.query('update pages set properties = $1::jsonb where id = $2', [
      JSON.stringify({ tags }),
      source.id,
    ]);
    const document = new Y.Doc();
    const client = await pool.connect();
    const querySpy = vi.spyOn(client, 'query');
    try {
      await client.query('begin');
      await updateConnections(
        client,
        source.id,
        Y.encodeStateAsUpdate(document),
        [{ userId: owner.id, isAnonymous: false }],
        logger,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
      document.destroy();
    }

    const insertionCalls = querySpy.mock.calls.filter(
      ([statement]) => typeof statement === 'string' && statement.includes('jsonb_to_recordset'),
    );
    expect(insertionCalls).toHaveLength(2);
    expect(
      insertionCalls.map((call) => {
        const parameters = call[1];
        const payload = Array.isArray(parameters) ? parameters[1] : undefined;
        return typeof payload === 'string' ? (JSON.parse(payload) as unknown[]).length : 0;
      }),
    ).toEqual([250, 1]);
    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from connections where source_type = 'page' and source_id = $1`,
      [source.id],
    );
    expect(count.rows[0]?.count).toBe('251');
  });
});
