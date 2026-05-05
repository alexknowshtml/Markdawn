import { expect, test } from '@playwright/test';

test.describe('Authentication Flows', () => {
  test('landing page has login link', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Welcome to Markdawn')).toBeVisible();
    await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
  });

  test('login page shows OAuth providers', async ({ page }) => {
    await page.goto('/login');

    await expect(
      page.getByRole('button', { name: /continue with google/i }).or(page.getByText(/google/i)),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /continue with github/i }).or(page.getByText(/github/i)),
    ).toBeVisible();
  });

  test('authenticated user is redirected from login', async ({ page }) => {
    await page.goto('/login');

    await expect(page).not.toHaveURL(/\/login/);
  });

  test('unauthenticated user accessing app redirects to login', async ({ page }) => {
    await page.goto('/app');

    await expect(page).toHaveURL(/\/login/);
  });
});
