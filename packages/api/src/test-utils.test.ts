import { describe, expect, it } from 'vitest';
import {
  createTestComment,
  createTestFolder,
  createTestPage,
  createTestPageLink,
  createTestPublicShare,
  createTestReply,
  createTestSession,
  createTestTemplate,
  createTestUser,
  createTestVersion,
} from './test-utils';

describe('test-utils factories', () => {
  it('createTestUser creates a user', async () => {
    const user = await createTestUser();
    expect(user.id).toBeTruthy();
    expect(user.email).toContain('@');
    expect(user.name).toBe('Test User');
  });

  it('createTestSession creates a valid session cookie', async () => {
    const user = await createTestUser();
    const session = await createTestSession(user.id);
    expect(session.Cookie).toContain('better-auth.session_token=');
  });

  it('createTestFolder creates a folder', async () => {
    const user = await createTestUser();
    const folder = await createTestFolder(user.id);
    expect(folder.id).toBeTruthy();
    expect(folder.name).toBe('Test Folder');
  });

  it('createTestPage creates a page', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.id);
    expect(page.id).toBeTruthy();
    expect(page.title).toBe('Test Page');
  });

  it('createTestComment and createTestReply create nested comments', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.id);
    const comment = await createTestComment(page.id, user.id);
    expect(comment.content).toBe('Test comment');

    const reply = await createTestReply(comment.id, user.id);
    expect(reply.content).toBe('Test reply');
  });

  it('createTestVersion creates a version for a page', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.id);
    const version = await createTestVersion(page.id, user.id);
    expect(version.pageId).toBe(page.id);
  });

  it('createTestTemplate creates a template', async () => {
    const user = await createTestUser();
    const tmpl = await createTestTemplate(user.id);
    expect(tmpl.id).toBeTruthy();
    expect(tmpl.title).toBe('Test Template');
  });

  it('createTestPageLink creates a backlink between pages', async () => {
    const user = await createTestUser();
    const page1 = await createTestPage(user.id);
    const page2 = await createTestPage(user.id);
    const link = await createTestPageLink(page1.id, page2.id);
    expect(link.sourcePageId).toBe(page1.id);
    expect(link.targetPageId).toBe(page2.id);
  });

  it('createTestPublicShare creates a share token for a page', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.id);
    const share = await createTestPublicShare(page.id);
    expect(share.pageId).toBe(page.id);
    expect(share.token).toBeTruthy();
  });
});
