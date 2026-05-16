import { expect, test } from '@playwright/test';
import { createNewPage } from '../fixtures';

test.describe('Properties panel', () => {
  test('1: shows empty state on a fresh page', async ({ page }) => {
    await createNewPage(page);
    await expect(page.getByTestId('add-property')).toBeVisible();
  });

  test('2: adds a property by typing a key and pressing Enter', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();

    const keyInput = page.getByTestId('key-input');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('mykey');
    await keyInput.press('Enter');

    const valueInput = page.getByTestId('value-input');
    await expect(valueInput).toBeVisible();
    await valueInput.fill('myvalue');
    await valueInput.press('Enter');

    await expect(page.getByText('myvalue')).toBeVisible();
    await expect(page.locator('[data-property-key="mykey"]')).toBeVisible();
  });

  test('3: adds a property by clicking a suggestion with mouse', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();

    const keyInput = page.getByTestId('key-input');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('dat');
    await page.getByRole('button', { name: 'date', exact: true }).click();

    const valueInput = page.getByTestId('value-input');
    await expect(valueInput).toBeVisible();
    await valueInput.fill('2024-06-15');
    await valueInput.press('Enter');

    await expect(page.locator('[data-property-key="date"]')).toBeVisible();
    await expect(page.getByText('2024-06-15')).toBeVisible();
  });

  test('4: edits a property value inline', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('editkey');
    await page.getByTestId('key-input').press('Enter');

    const valueInput = page.getByTestId('value-input');
    await valueInput.fill('initial');
    await valueInput.press('Enter');

    await page.getByText('initial').click();
    const editInput = page.getByTestId('value-input');
    await expect(editInput).toBeVisible();
    await editInput.fill('updated');
    await editInput.press('Enter');

    await expect(page.getByText('updated')).toBeVisible();
    await expect(page.getByText('initial')).not.toBeVisible();
  });

  test('5: deletes a single property', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('todelete');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('value');
    await page.getByTestId('value-input').press('Enter');

    await expect(page.locator('[data-property-key="todelete"]')).toBeVisible();

    const row = page.locator('[data-property-key="todelete"]');
    await row.hover();
    await row.getByTestId('delete-property').click();

    await expect(page.locator('[data-property-key="todelete"]')).not.toBeVisible();
  });

  test('6: returns to empty state after deleting the last property', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('onlyprop');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('val');
    await page.getByTestId('value-input').press('Enter');

    const row = page.locator('[data-property-key="onlyprop"]');
    await row.hover();
    await row.getByTestId('delete-property').click();

    await expect(page.getByTestId('add-property')).toBeVisible();
  });

  test('7: cancels value editing via Escape key', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('ekey');
    await page.getByTestId('key-input').press('Enter');

    const valueInput = page.getByTestId('value-input');
    await valueInput.fill('original');
    await valueInput.press('Enter');

    await page.getByText('original').click();
    const editInput = page.getByTestId('value-input');
    await editInput.fill('changed');
    await editInput.press('Escape');

    await expect(page.getByText('original')).toBeVisible();
    await expect(page.getByText('changed')).not.toBeVisible();
  });

  test('8: cancels key editing via Escape key', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('origkey');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('val');
    await page.getByTestId('value-input').press('Enter');

    await page
      .locator('[data-property-key="origkey"]')
      .getByRole('button', { name: 'origkey' })
      .click();

    const keyInput = page.getByTestId('key-input');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('changedkey');
    await keyInput.press('Escape');

    await expect(page.locator('[data-property-key="origkey"]')).toBeVisible();
    await expect(page.locator('[data-property-key="changedkey"]')).not.toBeVisible();
  });

  test('9: adds multiple properties in sequence', async ({ page }) => {
    await createNewPage(page);

    async function addProperty(key: string, value: string) {
      await page.getByTestId('add-property').click();
      await page.getByTestId('key-input').fill(key);
      await page.getByTestId('key-input').press('Enter');
      await page.getByTestId('value-input').fill(value);
      await page.getByTestId('value-input').press('Enter');
      await expect(page.getByText(value)).toBeVisible();
    }

    await addProperty('prop1', 'val1');
    await addProperty('prop2', 'val2');
    await addProperty('prop3', 'val3');

    await expect(page.locator('[data-property-key="prop1"]')).toBeVisible();
    await expect(page.locator('[data-property-key="prop2"]')).toBeVisible();
    await expect(page.locator('[data-property-key="prop3"]')).toBeVisible();
    await expect(page.getByTestId('property-count')).toHaveText('3');
  });

  test('10: does not persist a property with an empty key', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await expect(page.getByTestId('key-input')).toBeVisible();

    await page.locator('input[data-testid="page-title"]').click();
    await page.waitForTimeout(500);

    await page.reload();
    await page.waitForSelector('.ProseMirror', { timeout: 15000 });

    await expect(page.getByTestId('add-property')).toBeVisible();
  });

  test('11: rejects renaming a key to an existing key name', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('alpha');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('first');
    await page.getByTestId('value-input').press('Enter');
    await expect(page.getByText('first')).toBeVisible();

    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('beta');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('second');
    await page.getByTestId('value-input').press('Enter');
    await expect(page.getByText('second')).toBeVisible();

    await page
      .locator('[data-property-key="beta"]')
      .locator('button:not([data-testid="delete-property"])')
      .first()
      .click();

    const keyInput = page.getByTestId('key-input');
    await keyInput.fill('alpha');
    await keyInput.press('Enter');

    await expect(page.locator('[data-property-key="beta"]')).toBeVisible();
    await expect(page.locator('[data-property-key="alpha"]')).toBeVisible();
    await expect(page.locator('[data-property-key="beta"]')).toBeVisible();
  });

  test('12: persists properties after page reload', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('persistkey');
    await page.getByTestId('key-input').press('Enter');

    await expect(page.getByTestId('value-input')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('value-input').fill('persistval');
    await page.getByTestId('value-input').press('Enter');

    await expect(page.getByText('persistval')).toBeVisible();

    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForSelector('.ProseMirror', { timeout: 15000 });

    await expect(page.locator('[data-property-key="persistkey"]')).toBeVisible();
    await expect(page.getByText('persistval')).toBeVisible();
  });

  test('13: collapses and expands the properties panel', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('mykey');
    await page.getByTestId('key-input').press('Enter');
    await page.getByTestId('value-input').fill('val');
    await page.getByTestId('value-input').press('Enter');

    await expect(page.locator('[data-property-key="mykey"]')).toBeVisible();

    await page.getByTestId('properties-heading').click();
    await expect(page.locator('[data-property-key="mykey"]')).not.toBeVisible();

    await page.getByTestId('properties-heading').click();
    await expect(page.locator('[data-property-key="mykey"]')).toBeVisible();
  });

  test('14: adds and removes tag chips in a tags property', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('tags');
    await page.getByTestId('key-input').press('Enter');

    const tagInput = page.getByTestId('tag-input');
    await expect(tagInput).toBeVisible();

    await tagInput.fill('tagone');
    await tagInput.press('Enter');
    await expect(page.getByText('tagone')).toBeVisible();

    await tagInput.fill('tagtwo');
    await tagInput.press('Enter');
    await expect(page.getByText('tagone')).toBeVisible();
    await expect(page.getByText('tagtwo')).toBeVisible();

    const row = page.locator('[data-property-key="tags"]');
    const chip = row.locator('span').filter({ hasText: 'tagone' });
    await chip.locator('button').click();

    await expect(page.getByText('tagone')).not.toBeVisible();
    await expect(page.getByText('tagtwo')).toBeVisible();
  });

  test('15: renders a URL value as a clickable link', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('myurl');
    await page.getByTestId('key-input').press('Enter');

    const valueInput = page.getByTestId('value-input');
    await valueInput.fill('https://example.com');
    await valueInput.press('Enter');

    const link = page.locator('[data-property-key="myurl"] a');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('16: shows tags from other documents in the suggestion dropdown', async ({ page }) => {
    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('tags');
    await page.getByTestId('key-input').press('Enter');

    const tagInput = page.getByTestId('tag-input');
    await tagInput.fill('crossdoctag');
    await tagInput.press('Enter');
    await page.waitForTimeout(1500);

    await createNewPage(page);
    await page.getByTestId('add-property').click();
    await page.getByTestId('key-input').fill('tags');
    await page.getByTestId('key-input').press('Enter');

    const tagInputY = page.getByTestId('tag-input');
    await tagInputY.focus();
    await expect(page.getByText('crossdoctag')).toBeVisible();
  });
});
