import { expect, test } from '@playwright/test';

test.describe('Folder management', () => {
  test('create a folder', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app(\/|$)/, { timeout: 15000 });

    const folderBtn = page.locator('[data-testid="new-folder-btn"]');
    await expect(folderBtn).toBeVisible({ timeout: 5000 });
    await folderBtn.click();

    await expect(page.locator('text=New Folder').first()).toBeVisible({ timeout: 5000 });
  });

  test('folder appears in sidebar after creation', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app(\/|$)/, { timeout: 15000 });

    await page.locator('[data-testid="new-folder-btn"]').click();
    await expect(page.locator('text=New Folder').first()).toBeVisible({ timeout: 5000 });

    await page.reload();
    await page.waitForURL(/\/app(\/|$)/);
    await expect(page.locator('text=New Folder').first()).toBeVisible({ timeout: 10000 });
  });
});
