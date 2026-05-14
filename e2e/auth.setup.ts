import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { API_URL } from './fixtures';

const authFile = path.join(__dirname, 'playwright/.auth/user.json');

setup('authenticate', async ({ page, request }) => {
  // Create a test user and session via the API's dev-only test setup endpoint.
  // Disabled in production (NODE_ENV === 'production').
  const headers: Record<string, string> = {};
  const testToken = process.env.TEST_SETUP_TOKEN;
  if (testToken) {
    headers['x-test-setup-token'] = testToken;
  }

  const res = await request.post(`${API_URL}/api/test/setup`, {
    data: { name: 'Playwright Test User' },
    headers,
  });
  expect(res.ok()).toBeTruthy();

  const { cookie } = (await res.json()) as { cookie: string };

  const domain = new URL(API_URL).hostname;

  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: cookie,
      domain,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ]);

  await page.goto('/');
  if (!page.url().includes('/app/')) {
    await page.goto('/app/e2e-test-workspace/', { waitUntil: 'networkidle' });
  }
  expect(page.url()).toMatch(/\/app\//);
  await page.context().storageState({ path: authFile });
});
