import { type Page, expect } from '@playwright/test';

export const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export async function focusEditor(page: Page): Promise<void> {
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await editor.waitFor({ state: 'visible' });
}

export async function createNewPage(page: Page): Promise<string> {
  await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForURL(/\/app\//, { timeout: 15000 });
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
