import { test, expect } from '@playwright/test';
import { focusEditor, createNewPage } from '../fixtures';

test.describe('Markdown formatting shortcuts', () => {
  test('bold via **text**', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('**bold text**');
    await expect(page.locator('.ProseMirror strong')).toBeVisible({ timeout: 5_000 });
  });

  test('italic via *text*', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('*italic text*');
    await expect(page.locator('.ProseMirror em')).toBeVisible({ timeout: 5_000 });
  });

  test('strikethrough via ~~text~~', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('~~struck text~~');
    await expect(page.locator('.ProseMirror del, .ProseMirror s')).toBeVisible({ timeout: 5_000 });
  });

  test('inline code via `code`', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('`inline code`');
    await expect(page.locator('.ProseMirror code')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Markdown block shortcuts', () => {
  test('bullet list via - ', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('- item');
    await page.waitForTimeout(500);
    // The editor should contain the list item text
    await expect(page.locator('.ProseMirror')).toContainText('item', { timeout: 5_000 });
  });

  test('ordered list via 1. ', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('1. first');
    await page.waitForTimeout(500);
    await expect(page.locator('.ProseMirror')).toContainText('first', { timeout: 5_000 });
  });

  test('blockquote via > ', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('> quoted text');
    await page.waitForTimeout(500);
    await expect(page.locator('.ProseMirror')).toContainText('quoted text', { timeout: 5_000 });
  });
});
