import { expect, test } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Emoji / Page Icon', () => {
  test('page icon area is visible on a page', async ({ page }) => {
    await createNewPage(page);
    const iconArea = page.locator('svg.lucide-file-text').first();
    await expect(iconArea).toBeVisible({ timeout: 5000 });
  });
});
