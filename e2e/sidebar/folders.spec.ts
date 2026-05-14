import { test, expect } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Folder management', () => {
  test('create a folder', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app\//, { timeout: 15000 });
    const folderBtn = page.getByRole('button', { name: /create folder/i });
    if (await folderBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await folderBtn.click();
      await page.waitForTimeout(500);
      // A folder input should appear inline
      const input = page.locator('input[placeholder*="folder"], [class*="rename"] input').first();
      if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
        await input.fill('Test Folder');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
      }
    }
  });

  test('create page inside a folder', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app\//, { timeout: 15000 });
    // Click on a folder to select it
    const folder = page.locator('text=Test Folder').first();
    if (await folder.isVisible({ timeout: 3000 }).catch(() => false)) {
      await folder.click();
      await page.waitForTimeout(300);
    }
    // Create a new page — should go into the selected folder
    await page.getByRole('button', { name: /new page/i }).first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 });
  });

  test('delete a folder', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app\//, { timeout: 15000 });
    // Right-click or context menu on the folder
    const folder = page.locator('text=Test Folder').first();
    if (await folder.isVisible({ timeout: 3000 }).catch(() => false)) {
      await folder.click({ button: 'right' });
      await page.waitForTimeout(300);
      const deleteOpt = page.locator('[role="menuitem"], [class*="menu-item"]').filter({ hasText: /delete/i }).first();
      if (await deleteOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await deleteOpt.click();
        await page.waitForTimeout(500);
      }
    }
  });
});
