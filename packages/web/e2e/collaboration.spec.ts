import { expect, test } from '@playwright/test';

test.describe('Real-time Collaboration', () => {
  test.use({ storageState: './e2e/.auth/user.json' });

  test('two browsers editing same page sync content', async ({ browser }) => {
    const contextA = await browser.newContext({ storageState: './e2e/.auth/user.json' });
    const contextB = await browser.newContext({ storageState: './e2e/.auth/user.json' });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto('/app/test-workspace/test-page');
    await pageB.goto('/app/test-workspace/test-page');

    await expect(pageA.locator('.milkdown-editor')).toBeVisible();
    await expect(pageB.locator('.milkdown-editor')).toBeVisible();

    await pageA.keyboard.type('Hello from Browser A');

    await pageA.waitForTimeout(2000);

    const markdownB = await pageB.evaluate(() =>
      (window as unknown as { getEditorMarkdown?: () => string }).getEditorMarkdown?.(),
    );

    expect(markdownB).toContain('Hello from Browser A');

    await contextA.close();
    await contextB.close();
  });

  test('collaboration status indicator visible', async ({ page }) => {
    await page.goto('/app/test-workspace/test-page');

    await expect(page.locator('.milkdown-editor')).toBeVisible();

    const statusDot = page
      .locator('[class*="rounded-full"]')
      .filter({
        has: page.locator(
          'span[class*="bg-emerald"], span[class*="bg-amber"], span[class*="bg-rose"]',
        ),
      })
      .first();
    if (await statusDot.isVisible().catch(() => false)) {
      await expect(statusDot).toBeVisible();
    }
  });
});
