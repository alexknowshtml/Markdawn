import { expect, test } from '@playwright/test';

test.describe('Editor', () => {
  test('editor renders and accepts input', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');
    await expect(page.locator('.milkdown-editor')).toBeVisible();
    await page.keyboard.type('# Hello');
    expect(await page.evaluate(() => window.getEditorMarkdown())).toContain('# Hello');
  });
});
