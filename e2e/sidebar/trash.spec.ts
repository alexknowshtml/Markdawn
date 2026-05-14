import { expect, test } from '@playwright/test';
import { API_URL, createNewPage } from '../fixtures';

test.describe('Trash', () => {
  async function deletePageViaApi(page: import('@playwright/test').Page): Promise<string> {
    const url = await createNewPage(page);
    const match = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    const pageId = match?.[1] ?? '';
    const res = await page.request.delete(`${API_URL}/api/pages/${pageId}`);
    expect(res.ok()).toBeTruthy();
    return pageId;
  }

  test('trash view shows deleted page', async ({ page }) => {
    await deletePageViaApi(page);

    const trashBtn = page.locator('button:has(svg.lucide-trash-2)').first();
    await expect(trashBtn).toBeVisible({ timeout: 5000 });
    await trashBtn.click();

    await expect(page.getByRole('heading', { name: /Trash/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Untitled').first()).toBeVisible({ timeout: 5000 });
  });

  test('restore page from trash', async ({ page }) => {
    await deletePageViaApi(page);

    await page.locator('button:has(svg.lucide-trash-2)').first().click();
    await expect(page.getByRole('heading', { name: /Trash/i })).toBeVisible({ timeout: 5000 });

    const restoreBtn = page.getByTitle('Restore page').first();
    await expect(restoreBtn).toBeVisible({ timeout: 5000 });
    await restoreBtn.click({ force: true });

    await expect(page.getByText('Untitled').first()).toBeVisible({ timeout: 5000 });
  });
});
