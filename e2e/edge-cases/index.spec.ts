import { test, expect } from '@playwright/test';
import { focusEditor, createNewPage } from '../fixtures';

test.describe('Edge cases', () => {
  test('rapid typing does not cause hang', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    // Type a long sentence quickly
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    await page.keyboard.type(text, { delay: 10 });
    await page.waitForTimeout(500);
    // If the page didn't hang, this should pass
    await expect(page.locator('.ProseMirror')).toContainText('quick brown fox');
  });

  test('switching between heading levels works', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    // Create an h1
    await page.keyboard.type('# Heading');
    await expect(page.locator('.ProseMirror h1')).toBeVisible({ timeout: 5_000 });
    // Downgrade to h2 by typing ## and pressing Enter
    // First go to the end of the line
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    // Type ## - should make it an h2
    await page.keyboard.type('## Subheading');
    await expect(page.locator('.ProseMirror h2')).toBeVisible({ timeout: 5_000 });
  });

  test('backtick code block does not cause hang', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await expect(page.locator('.ProseMirror')).toBeVisible();
  });
});
