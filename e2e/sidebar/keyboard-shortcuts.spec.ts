import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Keyboard shortcuts', () => {
  test.describe('Ctrl+/ — Toggle sidebar', () => {
    test('toggles sidebar when nothing is focused', async ({ page }) => {
      await createNewPage(page);

      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });

      await page.keyboard.press('Control+/');
      await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
        timeout: 5000,
      });

      await page.keyboard.press('Control+/');
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    });

    test('toggles sidebar when ProseMirror editor is focused (contenteditable)', async ({
      page,
    }) => {
      await createNewPage(page);
      await focusEditor(page);

      await expect(page.locator('.ProseMirror')).toBeFocused();

      await page.keyboard.press('Control+/');
      await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
        timeout: 5000,
      });
    });

    test('toggles sidebar when page title input is focused', async ({ page }) => {
      await createNewPage(page);

      const titleInput = page.locator('input[data-testid="page-title"]');
      await titleInput.click();
      await expect(titleInput).toBeFocused();

      await page.keyboard.press('Control+/');
      await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
        timeout: 5000,
      });
    });

    test('toggles sidebar with Cmd+/ on Mac', async ({ page }) => {
      await createNewPage(page);

      await page.keyboard.press('Meta+/');
      await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
        timeout: 5000,
      });

      await page.keyboard.press('Meta+/');
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    });

    test('rapid toggle does not break state', async ({ page }) => {
      await createNewPage(page);

      await page.keyboard.press('Control+/');
      await page.keyboard.press('Control+/');
      await page.keyboard.press('Control+/');
      await page.keyboard.press('Control+/');

      // Even number of toggles → back to expanded
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Alt+N / Alt+Shift+N — Create page and folder', () => {
    test('Alt+N creates a new page and navigates to it', async ({ page }) => {
      await createNewPage(page);

      const urlBefore = page.url();

      await page.keyboard.press('Alt+n');
      await page.waitForURL(/\/app\/.+\/.+/);

      // Should have navigated to a new page (URL changed)
      const urlAfter = page.url();
      expect(urlAfter).not.toBe(urlBefore);
      expect(urlAfter).toMatch(/\/app\/.+\/.+/);
    });

    test('Alt+N works while focused in the editor', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('some text');

      const urlBefore = page.url();
      await page.keyboard.press('Alt+n');
      await page.waitForURL(/\/app\/.+\/.+/);

      // Should have navigated to a new page despite editor focus
      const urlAfter = page.url();
      expect(urlAfter).not.toBe(urlBefore);
    });

    test('Alt+Shift+N creates a new folder', async ({ page }) => {
      await createNewPage(page);

      const folderName = page.locator('text=New Folder').first();
      await expect(folderName).not.toBeVisible({ timeout: 3000 });

      await page.keyboard.press('Alt+Shift+n');

      await expect(folderName).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Ctrl+K — Command palette vs editor link', () => {
    test('opens and closes the command palette', async ({ page }) => {
      await createNewPage(page);

      await page.keyboard.press('Control+k');
      await expect(page.getByPlaceholder('Search pages...')).toBeVisible({ timeout: 5000 });

      await page.keyboard.press('Escape');
      await expect(page.getByPlaceholder('Search pages...')).not.toBeVisible({ timeout: 5000 });
    });

    test('Ctrl+K while typing in editor opens command palette (no text selected)', async ({
      page,
    }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('hello world');

      // No text selected, so Ctrl+K should open the command palette
      await page.keyboard.press('Control+k');
      await expect(page.getByPlaceholder('Search pages...')).toBeVisible({ timeout: 5000 });
    });

    test('Ctrl+K with text selected triggers link insertion prompt', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      // Type and select the word "link"
      await page.keyboard.type('insert link here');
      await page.keyboard.down('Shift');
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
      await page.keyboard.up('Shift');

      // Set up dialog handler before pressing Ctrl+K
      const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
      await page.keyboard.press('Control+k');

      const dialog = await dialogPromise;
      expect(dialog.type()).toBe('prompt');
      await dialog.accept('https://example.com');
    });

    test('palette scope isolation — parent shortcuts blocked while palette is open', async ({
      page,
    }) => {
      await createNewPage(page);

      await page.keyboard.press('Control+k');
      await expect(page.getByPlaceholder('Search pages...')).toBeVisible({ timeout: 5000 });

      const sidebarBefore = page.locator('[data-testid="sidebar"]');
      const isExpanded = await sidebarBefore.isVisible();

      await page.keyboard.press('Control+/');

      if (isExpanded) {
        await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 2000 });
      } else {
        await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
          timeout: 2000,
        });
      }
    });

    test('scope cleanup — parent shortcuts restore after palette closes', async ({ page }) => {
      await createNewPage(page);

      await page.keyboard.press('Control+k');
      await expect(page.getByPlaceholder('Search pages...')).toBeVisible({ timeout: 5000 });

      await page.keyboard.press('Escape');
      await expect(page.getByPlaceholder('Search pages...')).not.toBeVisible({ timeout: 5000 });

      // Ctrl+/ should now toggle sidebar again
      await page.keyboard.press('Control+/');
      await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({
        timeout: 5000,
      });
    });

    test('Alt+N is blocked while palette is open (scope isolation)', async ({ page }) => {
      await createNewPage(page);

      const urlBefore = page.url();

      await page.keyboard.press('Control+k');
      await expect(page.getByPlaceholder('Search pages...')).toBeVisible({ timeout: 5000 });

      await page.keyboard.press('Alt+n');

      // Should NOT have navigated — Alt+N blocked by palette scope
      expect(page.url()).toBe(urlBefore);
    });
  });

  test.describe('Editor formatting shortcuts', () => {
    test('Ctrl+B makes selected text bold', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('bold text');
      await page.keyboard.down('Shift');
      for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowLeft');
      await page.keyboard.up('Shift');

      await page.keyboard.press('Control+b');

      await expect(page.locator('.ProseMirror strong')).toHaveText('bold text');
    });

    test('Ctrl+I makes selected text italic', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('italic text');
      await page.keyboard.down('Shift');
      for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowLeft');
      await page.keyboard.up('Shift');

      await page.keyboard.press('Control+i');

      await expect(page.locator('.ProseMirror em')).toHaveText('italic text');
    });
  });

  test.describe('List shortcuts', () => {
    test('Ctrl+Shift+8 inserts a bullet list', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('List item');

      await page.keyboard.press('Control+Shift+8');

      await expect(page.locator('.ProseMirror ul')).toBeVisible({ timeout: 5000 });
    });

    test('Ctrl+Shift+7 inserts an ordered list', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('Numbered item');

      await page.keyboard.press('Control+Shift+7');

      await expect(page.locator('.ProseMirror ol')).toBeVisible({ timeout: 5000 });
    });

    test('Ctrl+Shift+[ inserts a task list', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('Task item');

      await page.keyboard.press('Control+Shift+[');

      await expect(page.locator('.ProseMirror li[data-item-type="task"]')).toBeVisible({
        timeout: 5000,
      });
    });
  });

  test.describe('Heading shortcuts', () => {
    test('Ctrl+Alt+1 converts paragraph to heading 1', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('Main heading');

      await page.keyboard.press('Control+Alt+1');

      await expect(page.locator('.ProseMirror h1')).toHaveText('Main heading');
    });
  });

  test.describe('No-op edge cases', () => {
    test('formatting shortcut with no selection does not crash', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      // Press formatting shortcuts without any text or selection
      await page.keyboard.press('Control+b');
      await page.keyboard.press('Control+i');
      await page.keyboard.press('Control+Shift+x');
      await page.keyboard.press('Control+`');

      // Editor should still be usable
      await page.keyboard.type('still works');
      await expect(page.locator('.ProseMirror')).toContainText('still works');
    });
  });

  test.describe('Theme and UI', () => {
    test('Ctrl+Shift+D toggles dark mode', async ({ page }) => {
      await createNewPage(page);

      const html = page.locator('html');
      const wasDark = await html.evaluate((el) => el.classList.contains('dark'));

      await page.keyboard.press('Control+Shift+d');

      if (wasDark) {
        await expect(html).not.toHaveClass(/dark/);
      } else {
        await expect(html).toHaveClass(/dark/);
      }
    });

    test('Theme toggle tooltip shows keyboard shortcut', async ({ page }) => {
      await createNewPage(page);

      const toggleBtn = page.locator('button[aria-label]').filter({ hasText: /theme/i });
      await toggleBtn.hover();

      await expect(page.getByText(/Ctrl\+Shift\+D|⌘\+Shift\+D/)).toBeVisible({ timeout: 3000 });
    });
  });

  test.describe('Non-interference', () => {
    test('plain typing in editor is not intercepted', async ({ page }) => {
      await createNewPage(page);
      await focusEditor(page);

      await page.keyboard.type('The quick brown fox jumps over the lazy dog.');

      await expect(page.locator('.ProseMirror p')).toContainText(
        'The quick brown fox jumps over the lazy dog.',
        { timeout: 5000 },
      );
    });
  });
});
