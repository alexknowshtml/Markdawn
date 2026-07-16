import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  test,
} from '@playwright/test';
import { API_URL } from '../fixtures';

type SetupResult = {
  cookie: string;
  userId: string;
};

type EntityResult = {
  id: string;
};

type ShareSummary = {
  accessors: Array<{ shareId?: string | null; userId: string }>;
};

const webHostname = new URL(process.env.BASE_URL ?? 'http://localhost:5173').hostname;

async function createUser(request: APIRequestContext, name: string): Promise<SetupResult> {
  const testToken = process.env.TEST_SETUP_TOKEN;
  if (!testToken) throw new Error('TEST_SETUP_TOKEN is required');
  const response = await request.post(`${API_URL}/api/test/setup`, {
    data: { name },
    headers: { 'x-test-setup-token': testToken },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as SetupResult;
}

async function createAuthenticatedContext(
  browser: Browser,
  session: SetupResult,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: session.cookie,
      domain: webHostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  return context;
}

async function createEntity(
  api: APIRequestContext,
  path: '/api/pages' | '/api/folders',
  data: Record<string, string>,
): Promise<EntityResult> {
  const response = await api.post(path, { data });
  expect(response.status()).toBe(201);
  return (await response.json()) as EntityResult;
}

async function getDirectShareId(
  ownerApi: APIRequestContext,
  entityType: 'page' | 'folder',
  entityId: string,
  recipientId: string,
): Promise<string> {
  const response = await ownerApi.get(`/api/shares/entity/${entityType}/${entityId}`);
  expect(response.ok()).toBeTruthy();
  const summary = (await response.json()) as ShareSummary;
  const shareId = summary.accessors.find(
    (accessor) => accessor.userId === recipientId && accessor.shareId,
  )?.shareId;
  if (!shareId) throw new Error('Direct share was not returned');
  return shareId;
}

test.describe('sharing realtime propagation', () => {
  test.setTimeout(120_000);

  test('refreshes invitations, permission fallback, folder revocation, and open share lists', async ({
    browser,
    request,
    playwright,
  }) => {
    const owner = await createUser(request, 'Realtime Sharing Owner');
    const recipient = await createUser(request, 'Realtime Sharing Recipient');
    const recipientEmail = `e2e-${recipient.userId.slice(0, 8)}@example.com`;
    const ownerApi = await playwright.request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Cookie: `better-auth.session_token=${owner.cookie}` },
    });
    const recipientApi = await playwright.request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Cookie: `better-auth.session_token=${recipient.cookie}` },
    });
    const ownerContext = await createAuthenticatedContext(browser, owner);
    const recipientContext = await createAuthenticatedContext(browser, recipient);

    try {
      const ownerPage = await ownerContext.newPage();
      const recipientPage = await recipientContext.newPage();
      const inviteTitle = `Realtime direct invite ${Date.now()}`;
      const invitePage = await createEntity(ownerApi, '/api/pages', { title: inviteTitle });

      await recipientPage.goto('/app');
      await expect(recipientPage.getByText(inviteTitle, { exact: true })).toHaveCount(0);
      const inviteResponse = await ownerApi.post(
        `/api/shares/entity/page/${invitePage.id}/invite`,
        { data: { email: recipientEmail, permission: 'view' } },
      );
      expect(inviteResponse.ok()).toBeTruthy();
      await expect(recipientPage.getByText(inviteTitle, { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });

      await ownerPage.goto(`/app/page-${invitePage.id}`);
      await ownerPage.locator('[data-testid="page-share-btn"]').click();
      await expect(ownerPage.getByRole('dialog')).toContainText('Realtime Sharing Recipient');
      const leaveResponse = await recipientApi.post(`/api/pages/${invitePage.id}/leave`);
      expect(leaveResponse.ok()).toBeTruthy();
      await expect(ownerPage.getByRole('dialog')).not.toContainText('Realtime Sharing Recipient', {
        timeout: 15_000,
      });

      const fallbackPage = await createEntity(ownerApi, '/api/pages', {
        title: `Realtime fallback ${Date.now()}`,
      });
      await ownerApi.patch(`/api/shares/entity/page/${fallbackPage.id}/link`, {
        data: { permission: 'view' },
      });
      await ownerApi.post(`/api/shares/entity/page/${fallbackPage.id}/invite`, {
        data: { email: recipientEmail, permission: 'edit' },
      });
      await recipientPage.goto(`/app/page-${fallbackPage.id}`);
      const fallbackEditor = recipientPage.locator('.ProseMirror');
      await expect(fallbackEditor).toHaveAttribute('contenteditable', 'true');
      const fallbackShareId = await getDirectShareId(
        ownerApi,
        'page',
        fallbackPage.id,
        recipient.userId,
      );
      expect((await ownerApi.delete(`/api/shares/${fallbackShareId}`)).ok()).toBeTruthy();
      await expect(fallbackEditor).toHaveAttribute('contenteditable', 'false', { timeout: 10_000 });

      const folder = await createEntity(ownerApi, '/api/folders', {
        name: `Realtime folder ${Date.now()}`,
      });
      const child = await createEntity(ownerApi, '/api/pages', {
        title: `Realtime folder child ${Date.now()}`,
        parentId: folder.id,
      });
      await ownerApi.post(`/api/shares/entity/folder/${folder.id}/invite`, {
        data: { email: recipientEmail, permission: 'admin' },
      });
      await ownerApi.post(`/api/shares/entity/page/${child.id}/invite`, {
        data: { email: recipientEmail, permission: 'view' },
      });
      await recipientPage.goto(`/app/page-${child.id}`);
      const inheritedEditor = recipientPage.locator('.ProseMirror');
      await expect(inheritedEditor).toHaveAttribute('contenteditable', 'true');
      expect(
        (
          await ownerApi.patch(`/api/shares/entity/page/${child.id}/inheritance`, {
            data: { policy: 'restricted' },
          })
        ).ok(),
      ).toBeTruthy();
      await expect(inheritedEditor).toHaveAttribute('contenteditable', 'false', {
        timeout: 10_000,
      });
      const childShareId = await getDirectShareId(ownerApi, 'page', child.id, recipient.userId);
      expect(
        (
          await ownerApi.patch(`/api/shares/entity/page/${child.id}/inheritance`, {
            data: { policy: 'inherit' },
          })
        ).ok(),
      ).toBeTruthy();
      await expect(inheritedEditor).toHaveAttribute('contenteditable', 'true', {
        timeout: 10_000,
      });
      expect((await ownerApi.delete(`/api/shares/${childShareId}`)).ok()).toBeTruthy();
      const folderShareId = await getDirectShareId(ownerApi, 'folder', folder.id, recipient.userId);
      expect((await ownerApi.delete(`/api/shares/${folderShareId}`)).ok()).toBeTruthy();
      await expect(recipientPage.locator('.ProseMirror')).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () => {
          const redirected = /\/app\/?$/.test(recipientPage.url());
          const denied = await recipientPage
            .getByRole('heading', { name: "You don't have access" })
            .isVisible();
          return redirected || denied;
        })
        .toBe(true);
    } finally {
      await ownerContext.close();
      await recipientContext.close();
      await ownerApi.dispose();
      await recipientApi.dispose();
    }
  });

  test('refreshes recursive deletion and workspace leave, and persists anonymous titles', async ({
    browser,
    request,
    playwright,
  }) => {
    const owner = await createUser(request, 'Realtime Metadata Owner');
    const member = await createUser(request, 'Realtime Metadata Member');
    const memberEmail = `e2e-${member.userId.slice(0, 8)}@example.com`;
    const ownerApi = await playwright.request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Cookie: `better-auth.session_token=${owner.cookie}` },
    });
    const memberApi = await playwright.request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Cookie: `better-auth.session_token=${member.cookie}` },
    });
    const ownerContext = await createAuthenticatedContext(browser, owner);
    const anonymousContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });

    try {
      const ownerPage = await ownerContext.newPage();
      const anonymousPage = await anonymousContext.newPage();
      const publicPage = await createEntity(ownerApi, '/api/pages', {
        title: `Anonymous title ${Date.now()}`,
      });
      expect(
        (
          await ownerApi.patch(`/api/shares/entity/page/${publicPage.id}/link`, {
            data: { permission: 'edit' },
          })
        ).ok(),
      ).toBeTruthy();
      await ownerPage.goto(`/app/page-${publicPage.id}`);
      await anonymousPage.goto(`/app/page-${publicPage.id}`);
      await anonymousPage.bringToFront();
      await expect(anonymousPage.locator('.ProseMirror')).toHaveAttribute(
        'contenteditable',
        'true',
      );
      await expect(anonymousPage.locator('[data-testid="page-title"]')).not.toHaveAttribute(
        'readonly',
        '',
      );
      const nextTitle = `Anonymous saved ${publicPage.id.slice(0, 8)}`;
      const titleResponsePromise = anonymousPage.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/api/pages/${publicPage.id}/title`),
      );
      await anonymousPage.locator('[data-testid="page-title"]').fill(nextTitle);
      await anonymousPage.locator('[data-testid="page-title"]').press('Enter');
      expect((await titleResponsePromise).ok()).toBeTruthy();
      await expect(ownerPage.locator('[data-testid="page-title"]')).toHaveValue(nextTitle, {
        timeout: 10_000,
      });
      const storedPage = await ownerApi.get(`/api/pages/${publicPage.id}`);
      expect((await storedPage.json()) as { title: string }).toMatchObject({ title: nextTitle });

      const deletedFolder = await createEntity(ownerApi, '/api/folders', {
        name: `Deleted folder ${Date.now()}`,
      });
      const deletedPage = await createEntity(ownerApi, '/api/pages', {
        title: `Deleted child ${Date.now()}`,
        parentId: deletedFolder.id,
      });
      await ownerPage.goto(`/app/page-${deletedPage.id}`);
      await expect(ownerPage.locator('.ProseMirror')).toBeVisible();
      expect(
        (await ownerApi.delete(`/api/folders/${deletedFolder.id}?force=true`)).ok(),
      ).toBeTruthy();
      await expect(ownerPage.locator('.ProseMirror')).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () => {
          const redirected = /\/app\/?$/.test(ownerPage.url());
          const missing = await ownerPage.getByText('Page not found.', { exact: true }).isVisible();
          return redirected || missing;
        })
        .toBe(true);

      expect(
        (
          await ownerApi.post('/api/workspace/members/invite', {
            data: { email: memberEmail, role: 'viewer' },
          })
        ).ok(),
      ).toBeTruthy();
      await ownerPage.goto('/app/settings');
      await expect(ownerPage.getByText('Realtime Metadata Member', { exact: true })).toBeVisible();
      const leaveWorkspace = await memberApi.delete(
        `/api/workspace/members/${member.userId}?workspaceOwnerId=${owner.userId}`,
      );
      expect(leaveWorkspace.ok()).toBeTruthy();
      await expect(ownerPage.getByText('Realtime Metadata Member', { exact: true })).toHaveCount(
        0,
        {
          timeout: 15_000,
        },
      );
    } finally {
      await ownerContext.close();
      await anonymousContext.close();
      await ownerApi.dispose();
      await memberApi.dispose();
    }
  });
});
