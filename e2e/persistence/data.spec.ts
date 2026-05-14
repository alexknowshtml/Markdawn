import { test, expect } from '@playwright/test';
import { focusEditor, createNewPage, renamePageViaTitleInput, getEditorText } from '../fixtures';

test.describe('Data persistence', () => {
  test('content persists after page reload', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('hello world');

    await page.reload();
    await page.waitForURL(/\/app\//);

    // Editor should have the content back
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ProseMirror')).toContainText('hello world');
  });

  test('title and content both persist after reload', async ({ page }) => {
    await createNewPage(page);
    await renamePageViaTitleInput(page, 'Full Test Page');
    await focusEditor(page);
    await page.keyboard.type('This is some sample content.');

    await page.reload();
    await page.waitForURL(/\/app\//);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('input[data-testid="page-title"]')).toHaveValue('Full Test Page');
    await expect(page.locator('.ProseMirror')).toContainText('This is some sample content.');
  });

  test('deleted content stays deleted after reload', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Temporary content');

    // Select all and delete
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');

    await page.reload();
    await page.waitForURL(/\/app\//);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });

    // After deleting and reloading, the editor should be empty
    await expect(page.locator('.ProseMirror p')).toBeVisible();
  });

  test('content survives after closing and reopening the browser tab', async ({ page, context }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Tab close test');

    // Close the tab and open a new one to the same URL
    const url = page.url();
    await page.close();
    const newPage = await context.newPage();
    await newPage.goto(url);
    await newPage.waitForURL(/\/app\//);

    await expect(newPage.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });
    await expect(newPage.locator('.ProseMirror')).toContainText('Tab close test');
    await newPage.close();
  });
});
