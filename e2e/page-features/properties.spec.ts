import { expect, test } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Properties panel', () => {
  test('properties panel is visible on a page', async ({ page }) => {
    await createNewPage(page);

    const panel = page.locator('input[data-testid="page-title"]').first();
    await expect(panel).toBeVisible({ timeout: 5000 });
  });
});
