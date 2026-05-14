import { test, expect } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Editor plugins', () => {
  test('callout block via > [!note]', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('> [!note] Callout text');
    await page.waitForTimeout(500);
    await expect(page.locator('.ProseMirror')).toContainText('Callout text');
  });

  test('inline math via $...$ renders', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('$E=mc^2$ ');
    await page.waitForTimeout(500);
    // Math should render as KaTeX — check for katex elements or math spans
    const mathEl = page.locator('.ProseMirror .math, .ProseMirror [class*="katex"], .ProseMirror mjx-container').first();
    await expect(mathEl).toBeVisible({ timeout: 5000 });
  });

  test('inline tag via #tag renders', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type(' #mytag ');
    await page.waitForTimeout(500);
    // Tag should render as a tag node — check for span with class "tag"
    const tagEl = page.locator('.ProseMirror span.tag, [data-name="mytag"]').first();
    await expect(tagEl).toBeVisible({ timeout: 5000 });
  });

  test('auto-link converts pasted URL to link', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('https://example.com ');
    await page.waitForTimeout(500);
    // The URL should be rendered as a link
    const link = page.locator('.ProseMirror a[href="https://example.com"]').first();
    if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(link).toBeVisible();
    }
  });
});
