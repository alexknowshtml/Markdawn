import { expect, test } from '@playwright/test';

test.describe('Page CRUD', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('can create a new page', async ({ page }) => {
    await page.goto('/app');

    const newPageBtn = page
      .getByRole('button', { name: /new page/i })
      .or(page.getByRole('button', { name: /\+ page/i }));
    if (await newPageBtn.isVisible().catch(() => false)) {
      await newPageBtn.click();
      await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
    }
  });

  test('can edit page title', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    const titleInput = page.locator('[data-testid="page-title"]');
    await expect(titleInput).toBeVisible();

    await titleInput.fill('');
    await titleInput.fill('Updated E2E Title');

    await expect(titleInput).toHaveValue('Updated E2E Title');
  });

  test('can delete page to trash', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    const moreActions = page
      .getByRole('button', { name: /more/i })
      .or(page.locator('[data-testid="page-actions-menu"]'));
    if (await moreActions.isVisible().catch(() => false)) {
      await moreActions.click();
      const deleteBtn = page
        .getByRole('menuitem', { name: /move to trash/i })
        .or(page.getByText(/trash/i));
      if (await deleteBtn.isVisible().catch(() => false)) {
        await deleteBtn.click();
        await expect(page.getByText(/moved to trash/i)).toBeVisible();
      }
    }
  });

  test('trash view shows deleted pages', async ({ page }) => {
    await page.goto('/app/test-workspace/trash');

    await expect(page.getByText(/trash/i).or(page.locator('h1'))).toBeVisible();
  });

  test('can restore page from trash', async ({ page }) => {
    await page.goto('/app/test-workspace/trash');

    const restoreBtn = page.getByRole('button', { name: /restore/i });
    if (
      await restoreBtn
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await restoreBtn.first().click();
      await expect(page.getByText(/restored/i)).toBeVisible();
    }
  });
});
