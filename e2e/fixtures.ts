import { expect, type Page } from '@playwright/test';

export const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ state: 'visible' });

  // The editor becomes visible before the collaboration provider has applied
  // its initial document. Typing during that window can be overwritten by the
  // initial Yjs sync. Wait for the live status, then ensure the same editable
  // node remains mounted while that sync settles.
  await page.locator('main .bg-emerald-500').first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  await expect
    .poll(
      async () => {
        const currentEditor = await editor.elementHandle();
        if (!currentEditor) return false;
        await page.waitForTimeout(750);
        return currentEditor.evaluate(
          (element) =>
            element.isConnected &&
            element.getAttribute('contenteditable') === 'true' &&
            document.querySelector('.ProseMirror') === element,
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await editor.click();
}

export async function createNewPage(page: Page): Promise<string> {
  await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15000 });
  await page
    .getByRole('button', { name: /new page/i })
    .first()
    .click();
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  return page.url();
}

export async function renamePageViaTitleInput(page: Page, newTitle: string): Promise<void> {
  const titleInput = page.locator('input[data-testid="page-title"]');
  await titleInput.click();
  await titleInput.fill('');
  await titleInput.fill(newTitle);
  await page.keyboard.press('Enter');
  await expect(titleInput).toHaveValue(newTitle, { timeout: 5000 });
}
