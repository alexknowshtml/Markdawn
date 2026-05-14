import { expect, test } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Favorites', () => {
  test('favorite button is visible on a page', async ({ page }) => {
    await createNewPage(page);

    const favBtn = page.getByRole('button', { name: /Add to favorites/i }).first();
    await expect(favBtn).toBeVisible({ timeout: 5000 });
  });
});
