import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Slash menu', () => {
  test('can search and insert heading blocks', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    await page.keyboard.type('/h2');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Heading from slash');

    await expect(page.locator('.ProseMirror h2')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ProseMirror h2')).toHaveText('Heading from slash');
  });

  test('can insert checklist items from slash command', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    await page.keyboard.type('/check');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Task from slash');

    await expect(page.locator('.ProseMirror li[data-item-type="task"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('.ProseMirror li[data-item-type="task"]')).toContainText(
      'Task from slash',
    );
  });
});
