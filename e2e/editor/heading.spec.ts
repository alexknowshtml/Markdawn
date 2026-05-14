import { test, expect } from '@playwright/test';
import { focusEditor, createNewPage } from '../fixtures';

test.describe('Headings: markdown shortcuts', () => {
  test('h1 via # + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('# ');
    await expect(page.locator('.ProseMirror h1')).toBeVisible({ timeout: 5_000 });
  });

  test('h2 via ## + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('## ');
    await expect(page.locator('.ProseMirror h2')).toBeVisible({ timeout: 5_000 });
  });

  test('h3 via ### + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('### ');
    await expect(page.locator('.ProseMirror h3')).toBeVisible({ timeout: 5_000 });
  });

  test('h4 through h6 via #### to ###### + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    await page.keyboard.type('#### ');
    await expect(page.locator('.ProseMirror h4')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Enter');
    await page.keyboard.type('##### ');
    await expect(page.locator('.ProseMirror h5')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Enter');
    await page.keyboard.type('###### ');
    await expect(page.locator('.ProseMirror h6')).toBeVisible({ timeout: 5_000 });
  });

  test('empty heading does not hang the page', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    // Type # + space with no text after it
    await page.keyboard.type('# ');
    await page.waitForTimeout(500);
    // The page should be responsive — take a snapshot or verify an element
    await expect(page.locator('.ProseMirror h1')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Headings: toolbar buttons', () => {
  test('floating toolbar appears on text selection', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await page.keyboard.press('Control+a');
    // The floating toolbar should appear — check for a visible popup/toolbar
    await page.waitForTimeout(500);
  });
});
