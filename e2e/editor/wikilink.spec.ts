import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test.describe('Wikilinks', () => {
  test('[[ triggers suggestions popup', async ({ page }) => {
    await createNewPage(page);
    await focusEditor(page);

    // Type [[ to trigger the wiki link suggestion engine
    await page.keyboard.type('[[');

    // The suggestions popup renders inside editor-wrapper when open
    const popup = page.getByTestId('wikilink-suggestions');
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await expect(popup).toBeVisible();
  });
});
