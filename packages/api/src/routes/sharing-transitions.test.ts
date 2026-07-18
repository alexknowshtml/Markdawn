import { describe, expect, it } from 'vitest';
import { query } from '../db/query';
import {
  createTestApp,
  createTestFolder,
  createTestPage,
  createTestSession,
  createTestUser,
} from '../test-utils';

type Operation = 'direct' | 'folder' | 'move';
type Permission = null | 'view' | 'edit' | 'admin';

const orders: readonly (readonly Operation[])[] = [
  ['direct', 'folder', 'move'],
  ['direct', 'move', 'folder'],
  ['folder', 'direct', 'move'],
  ['folder', 'move', 'direct'],
  ['move', 'direct', 'folder'],
  ['move', 'folder', 'direct'],
];

async function effectivePagePermission(pageId: string, userId: string): Promise<Permission> {
  const result = await query<{ permission: Permission }>(
    'SELECT permission FROM get_effective_page_permission($1, $2)',
    [pageId, userId],
  );
  return result.rows[0]?.permission ?? null;
}

describe('sharing operation-order transitions', () => {
  it('converges for every direct-share, folder-share, and move ordering', async () => {
    const app = await createTestApp();

    for (const order of orders) {
      const owner = await createTestUser();
      const recipient = await createTestUser();
      const ownerSession = await createTestSession(owner.id);
      const folder = await createTestFolder(owner.id, { name: `Order ${order.join('-')}` });
      const page = await createTestPage(owner.id, { title: `Page ${order.join('-')}` });
      let hasDirect = false;
      let hasFolder = false;
      let isMoved = false;

      for (const operation of order) {
        if (operation === 'direct') {
          const response = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
            body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
          });
          expect(response.status, `${order.join(' -> ')} direct share`).toBe(200);
          hasDirect = true;
        } else if (operation === 'folder') {
          const response = await app.request(`/api/shares/entity/folder/${folder.id}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
            body: JSON.stringify({ email: recipient.email, permission: 'view' }),
          });
          expect(response.status, `${order.join(' -> ')} folder share`).toBe(200);
          hasFolder = true;
        } else {
          const response = await app.request(`/api/pages/${page.id}/move`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
            body: JSON.stringify({ parentId: folder.id }),
          });
          expect(response.status, `${order.join(' -> ')} move`).toBe(200);
          isMoved = true;
        }

        const expected: Permission = hasDirect ? 'edit' : hasFolder && isMoved ? 'view' : null;
        expect(
          await effectivePagePermission(page.id, recipient.id),
          `${order.join(' -> ')} after ${operation}`,
        ).toBe(expected);
      }

      const directShare = await query<{ id: string }>(
        `SELECT id FROM shares
         WHERE entity_type = 'page' AND entity_id = $1 AND recipient_user_id = $2`,
        [page.id, recipient.id],
      );
      const directShareId = directShare.rows[0]?.id;
      if (!directShareId) throw new Error('Expected direct page share');

      const revoke = await app.request(`/api/shares/${directShareId}`, {
        method: 'DELETE',
        headers: { Cookie: ownerSession.Cookie },
      });
      expect(revoke.status).toBe(200);
      expect(await effectivePagePermission(page.id, recipient.id)).toBe('view');

      const restrict = await app.request(`/api/shares/entity/page/${page.id}/inheritance`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ policy: 'restricted' }),
      });
      expect(restrict.status).toBe(200);
      expect(await effectivePagePermission(page.id, recipient.id)).toBeNull();

      const directWhileRestricted = await app.request(`/api/shares/entity/page/${page.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerSession.Cookie },
        body: JSON.stringify({ email: recipient.email, permission: 'edit' }),
      });
      expect(directWhileRestricted.status).toBe(200);
      expect(await effectivePagePermission(page.id, recipient.id)).toBe('edit');
    }
  });
});
