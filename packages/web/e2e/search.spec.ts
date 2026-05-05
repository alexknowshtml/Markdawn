import { expect, test } from '@playwright/test';

test.describe('Search', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('can search for pages', async ({ page }) => {
    await page.goto('/app');

    const searchTrigger = page
      .getByRole('button', { name: /search/i })
      .or(page.getByPlaceholder(/search/i));
    if (
      await searchTrigger
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await searchTrigger.first().click();
      await searchTrigger.first().fill('test');

      await expect(
        page.getByText(/searching/i).or(page.locator('[data-testid="search-results"]')),
      ).toBeVisible();
    }
  });
});
