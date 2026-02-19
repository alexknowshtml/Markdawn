import { test, expect } from '@playwright/test';

test('basic navigation and app shell', async ({ page }) => {
  // 1. Landing Page
  await page.goto('/');
  await expect(page.getByText('Welcome to MarkDawn')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log In' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to App' })).toBeVisible();

  // 2. Navigate to App Dashboard
  await page.getByRole('link', { name: 'Go to App' }).click();
  await expect(page).toHaveURL('/app');
  await expect(page.getByText('Select a Workspace')).toBeVisible();
  
  // Verify Sidebar is present (desktop)
  await expect(page.getByRole('heading', { name: 'MarkDawn' })).toBeVisible();

  // 3. Navigate to a workspace via sidebar
  await page.getByRole('link', { name: 'Demo Workspace' }).click();
  await expect(page).toHaveURL('/app/demo');
  await expect(page.getByRole('heading', { name: 'demo Workspace' })).toBeVisible();

  // 4. Navigate to a page
  await page.getByText('Project Note 1').click();
  await expect(page).toHaveURL('/app/demo/page-1');
  await expect(page.getByRole('heading', { name: 'page 1' })).toBeVisible();
  
  // Verify back navigation works (browser back)
  await page.goBack();
  await expect(page).toHaveURL('/app/demo');
});
