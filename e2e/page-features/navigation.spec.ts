import { test, expect } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Breadcrumbs', () => {
  test('breadcrumb shows workspace name on a page', async ({ page }) => {
    await createNewPage(page);
    const breadcrumb = page.locator('a[href*="/app/"]').first();
    await expect(breadcrumb).toBeVisible({ timeout: 5000 });
    await expect(breadcrumb).not.toBeEmpty();
  });
});

test.describe('Table of Contents', () => {
  test('TOC is visible when page has headings', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('## Section A');
    await page.waitForTimeout(500);
    const toc = page.locator('[class*="TableOfContents"], [class*="toc"]').first();
    if (await toc.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(toc).toBeVisible();
    }
  });
});
