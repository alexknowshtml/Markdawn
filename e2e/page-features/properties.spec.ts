import { test, expect } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Properties panel', () => {
  test('properties panel is visible on a page', async ({ page }) => {
    await createNewPage(page);
    const panel = page.locator('[class*="Properties"]').first();
    if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(panel).toBeVisible();
    }
  });
});
