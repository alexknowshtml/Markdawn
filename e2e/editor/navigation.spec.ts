import { test, expect } from '@playwright/test';
import { focusEditor, createNewPage } from '../fixtures';

test.describe('Navigation between pages', () => {
  test('create two pages and switch between them without hang', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Page one content');

    // Go back to workspace and create another
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForURL(/\/app\//);

    await page.getByRole('button', { name: /new page/i }).first().click();
    await page.waitForURL(/\/app\/.+\/untitled-/);
    await focusEditor(page);
    await page.keyboard.type('Page two content');
    await expect(page.locator('.ProseMirror')).toContainText('Page two content');
  });
});
