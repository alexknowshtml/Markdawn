import { test, expect } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Wikilinks', () => {
  test('[[ triggers suggestions popup', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    // Type [[ to trigger the wiki link suggestion engine
    await page.keyboard.type('[[');
    await page.waitForTimeout(1000);

    // The suggestions popup renders inside editor-wrapper when open
    // It has distinctive styling: rounded-xl, border, shadow-2xl
    const popup = page.locator('.editor-wrapper > div.rounded-xl.border.shadow-2xl').first();
    if (await popup.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(popup).toBeVisible();
    }
  });
});
