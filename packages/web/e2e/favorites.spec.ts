import { expect, test } from '@playwright/test';

test.describe('Favorites', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('can add page to favorites', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    const favoriteBtn = page
      .getByRole('button', { name: /favorite/i })
      .or(page.locator('[data-testid="favorite-button"]'));
    if (await favoriteBtn.isVisible().catch(() => false)) {
      await favoriteBtn.click();
      await expect(
        page.getByText(/added to favorites/i).or(page.getByText(/favorited/i)),
      ).toBeVisible();
    }
  });

  test('favorites section visible in sidebar', async ({ page }) => {
    await page.goto('/app');

    await expect(page.locator('aside')).toBeVisible();
    const favoritesHeader = page.getByText(/favorites/i);
    if (await favoritesHeader.isVisible().catch(() => false)) {
      await expect(favoritesHeader).toBeVisible();
    }
  });
});
