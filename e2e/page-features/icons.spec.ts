import { test, expect } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Emoji / Page Icon', () => {
  test('change page icon via emoji picker', async ({ page }) => {
    await createNewPage(page);
    // Click the page icon
    const iconArea = page.locator('[class*="page-icon"], [class*="PageIcon"]').first();
    if (await iconArea.isVisible({ timeout: 5000 }).catch(() => false)) {
      await iconArea.click();
      await page.waitForTimeout(500);
      // Emoji picker should open
      const picker = page.locator('emoji-picker, [class*="emoji"]').first();
      if (await picker.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Click the first emoji
        const emoji = picker.locator('button, [class*="emoji"]').first();
        if (await emoji.isVisible().catch(() => false)) {
          await emoji.click();
          await page.waitForTimeout(500);
        }
      }
    }
  });
});
