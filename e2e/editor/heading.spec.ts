import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Headings: markdown shortcuts', () => {
  test('h1 via # + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('# Heading 1');
    await expect(page.locator('.ProseMirror h1')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h1')).toHaveText('Heading 1');
  });

  test('h2 via ## + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('## Heading 2');
    await expect(page.locator('.ProseMirror h2')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h2')).toHaveText('Heading 2');
  });

  test('h3 via ### + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('### Heading 3');
    await expect(page.locator('.ProseMirror h3')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h3')).toHaveText('Heading 3');
  });

  test('h4 through h6 via #### to ###### + space', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    await page.keyboard.type('#### Heading 4');
    await expect(page.locator('.ProseMirror h4')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h4')).toHaveText('Heading 4');

    await page.keyboard.press('Enter');
    await page.keyboard.type('##### Heading 5');
    await expect(page.locator('.ProseMirror h5')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h5')).toHaveText('Heading 5');

    await page.keyboard.press('Enter');
    await page.keyboard.type('###### Heading 6');
    await expect(page.locator('.ProseMirror h6')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ProseMirror h6')).toHaveText('Heading 6');
  });

  test('empty heading does not hang the page', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    // Type # + space with no text after it
    await page.keyboard.type('# ');
    await page.locator('.ProseMirror h1').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('.ProseMirror h1')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Headings: toolbar buttons', () => {
  test('floating toolbar appears on text selection', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await page.keyboard.press('Control+a');
    const toolbar = page.locator('.floating-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 5000 });
  });
});
