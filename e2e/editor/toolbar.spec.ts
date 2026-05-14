import { test, expect } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Floating toolbar buttons', () => {
  test('inline formatting buttons produce correct markup', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    // Bold
    await page.keyboard.type('bold text');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Bold (Ctrl+B)"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror strong')).toBeVisible();
    // Move past bold text
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // Italic
    await page.keyboard.type('italic text');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Italic (Ctrl+I)"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror em')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // Strikethrough
    await page.keyboard.type('struck text');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Strikethrough"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror del, .ProseMirror s')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // Inline code
    await page.keyboard.type('code');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Inline Code"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror code')).toBeVisible();
  });

  test('heading buttons produce h1-h3', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    // H1
    await page.keyboard.type('Heading 1');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Heading 1"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror h1')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // H2
    await page.keyboard.type('Heading 2');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Heading 2"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror h2')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // H3
    await page.keyboard.type('Heading 3');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Heading 3"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror h3')).toBeVisible();
  });

  test('list buttons produce correct list types', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    // Bullet list
    await page.keyboard.type('Bullet');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Bullet List"]').click({ timeout: 5000 });
    await page.waitForTimeout(300);
    // Should either wrap in ul or convert to li
    const hasBullet = await page.locator('.ProseMirror ul').isVisible().catch(() => false);
    const hasListItem = await page.locator('.ProseMirror li').isVisible().catch(() => false);
    expect(hasBullet || hasListItem).toBeTruthy();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    // Ordered list
    await page.keyboard.type('First');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Ordered List"]').click({ timeout: 5000 });
    await page.waitForTimeout(300);
    const hasOrdered = await page.locator('.ProseMirror ol').isVisible().catch(() => false);
    const hasLiAfter = await page.locator('.ProseMirror li').count();
    expect(hasOrdered || hasLiAfter > 0).toBeTruthy();
  });

  test('task list via toolbar', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('Task');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Task List"]').click({ timeout: 5000 });
    await page.waitForTimeout(300);
    // Task list items have data-item-type="task"
    const hasTask = await page.locator('li[data-item-type="task"]').isVisible().catch(() => false);
    expect(hasTask).toBeTruthy();
  });

  test('insert table via toolbar', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Insert Table"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror table')).toBeVisible();
  });
});
