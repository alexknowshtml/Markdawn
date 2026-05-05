import path from 'node:path';
import { test as setup } from '@playwright/test';

const authFile = path.resolve(__dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  await page.waitForURL(/\/login/);

  try {
    await page.getByRole('button', { name: /continue with google/i }).waitFor({ timeout: 3000 });
    await page.context().storageState({ path: authFile });
  } catch {
    setup.skip(true, 'Auth provider not configured for E2E environment');
  }
});
