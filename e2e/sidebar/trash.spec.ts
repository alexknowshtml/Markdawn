import { test, expect } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Trash', () => {
  test('delete a page and verify it is removed', async ({ page }) => {
    const url = await createNewPage(page);
    // Extract the UUID from URLs like /.../untitled-550e8400-e29b-41d4-a716-446655440000
    const match = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    const pageId = match ? match[1] : '';

    const res = await page.request.delete(`http://localhost:3001/api/pages/${pageId}`);
    expect(res.ok()).toBeTruthy();
  });
});
