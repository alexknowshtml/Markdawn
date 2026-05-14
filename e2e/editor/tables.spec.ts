import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Table operations', () => {
  test('insert table and add rows', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Insert Table"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror table')).toBeVisible();

    // Click inside the table to show table manipulation buttons
    await page.locator('.ProseMirror td, .ProseMirror th').first().click();

    // Add a row below
    const addRowBtn = page.locator('.floating-toolbar button[title="Add Row Below"]');
    await addRowBtn.waitFor({ state: 'visible', timeout: 3000 });
    const rowCountBefore = await page.locator('.ProseMirror tr').count();
    await addRowBtn.click();
    const rowCountAfter = await page.locator('.ProseMirror tr').count();
    expect(rowCountAfter).toBeGreaterThan(rowCountBefore);
  });

  test('delete table from toolbar', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Control+a');
    await page.locator('.floating-toolbar button[title="Insert Table"]').click({ timeout: 5000 });
    await expect(page.locator('.ProseMirror table')).toBeVisible();

    await page.locator('.ProseMirror td, .ProseMirror th').first().click();

    const deleteBtn = page.locator('.floating-toolbar button[title="Delete Table"]');
    await deleteBtn.waitFor({ state: 'visible', timeout: 3000 });
    await deleteBtn.click();
    await expect(page.locator('.ProseMirror table')).not.toBeVisible();
  });
});
