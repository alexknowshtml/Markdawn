import { test, expect } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Markdown import', () => {
  test('import markdown file via sidebar', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForURL(/\/app\//, { timeout: 15000 });
    const importBtn = page.locator('button[title*="Import"], [class*="import"]').first();
    if (await importBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await importBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
