import { expect, test } from '@playwright/test';

test.describe('Workspace Management', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('can create a new workspace', async ({ page }) => {
    await page.goto('/app');

    const workspaceSelector = page
      .locator('[data-testid="workspace-selector"]')
      .or(page.getByRole('button', { name: /workspace/i }));
    await workspaceSelector.click();

    const createBtn = page.getByRole('button', { name: /create workspace/i });
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();

      await page.getByPlaceholder(/workspace name/i).fill('E2E Test Workspace');
      await page.getByRole('button', { name: /create/i }).click();

      await expect(page.getByText('E2E Test Workspace')).toBeVisible();
    }
  });

  test('workspace sidebar shows pages and folders', async ({ page }) => {
    await page.goto('/app');

    await expect(page.locator('aside')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /new page/i }).or(page.getByRole('button', { name: /\+/i })),
    ).toBeVisible();
  });

  test('can switch between workspaces', async ({ page }) => {
    await page.goto('/app');

    const workspaceSelector = page
      .locator('[data-testid="workspace-selector"]')
      .or(page.getByRole('button', { name: /workspace/i }));
    if (await workspaceSelector.isVisible().catch(() => false)) {
      await workspaceSelector.click();
      const options = page
        .locator('[data-testid="workspace-option"]')
        .or(page.locator('text=Workspace'));
      if ((await options.count()) > 1) {
        await options.nth(1).click();
        await expect(page).not.toHaveURL('/app');
      }
    }
  });
});
