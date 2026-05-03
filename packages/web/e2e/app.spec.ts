import { expect, test } from '@playwright/test';

test('basic navigation and app shell', async ({ page }) => {
  // 1. Landing Page
  await page.goto('/');
  await expect(page.getByText('Welcome to Markdawn')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get Started' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Learn More' })).toBeVisible();
});
