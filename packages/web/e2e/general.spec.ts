import { expect, test } from '@playwright/test';

test.describe('General App Navigation', () => {
  test('landing page shows welcome message and CTA links', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Welcome to Markdawn')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Get Started' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Learn More' })).toBeVisible();
  });

  test('login page is accessible from landing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: 'Get Started' }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test('redirects unknown routes to home', async ({ page }) => {
    await page.goto('/nonexistent-route-xyz');

    await expect(page).toHaveURL('/');
  });
});

test.describe('Authenticated Dashboard', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('redirects authenticated user away from login', async ({ page }) => {
    await page.goto('/login');

    await expect(page).not.toHaveURL(/\/login/);
  });

  test('dashboard loads with sidebar', async ({ page }) => {
    await page.goto('/app');

    await expect(page.locator('aside')).toBeVisible();
  });
});

test.describe('Editor', () => {
  test('editor renders and accepts input', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    await expect(page.locator('.milkdown-editor')).toBeVisible();

    await page.keyboard.type('# Hello Markdawn');
    const markdown = await page.evaluate(() =>
      (window as unknown as { getEditorMarkdown?: () => string }).getEditorMarkdown?.(),
    );
    expect(markdown).toContain('# Hello Markdawn');
  });

  test('editor supports bold formatting via shortcut', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    await expect(page.locator('.milkdown-editor')).toBeVisible();

    await page.keyboard.type('Bold text');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');

    const markdown = await page.evaluate(() =>
      (window as unknown as { getEditorMarkdown?: () => string }).getEditorMarkdown?.(),
    );
    expect(markdown).toContain('**Bold text**');
  });
});
