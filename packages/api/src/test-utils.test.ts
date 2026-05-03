import { describe, expect, it } from 'vitest';
import {
  createTestComment,
  createTestFolder,
  createTestPage,
  createTestPageLink,
  createTestPublicShare,
  createTestReply,
  createTestSession,
  createTestTag,
  createTestTemplate,
  createTestUser,
  createTestVersion,
  createTestWorkspace,
} from './test-utils';

describe('test-utils factories', () => {
  it('createTestUser creates a user with a personal workspace', async () => {
    const user = await createTestUser();
    expect(user.id).toBeTruthy();
    expect(user.email).toContain('@');
    expect(user.workspaceId).toBeTruthy();
  });

  it('createTestSession creates a valid session cookie', async () => {
    const user = await createTestUser();
    const session = await createTestSession(user.id);
    expect(session.Cookie).toContain('better-auth.session_token=');
  });

  it('createTestWorkspace creates a non-personal workspace', async () => {
    const user = await createTestUser();
    const ws = await createTestWorkspace(user.id);
    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe('Test Workspace');
  });

  it('createTestFolder creates a folder in a workspace', async () => {
    const user = await createTestUser();
    const folder = await createTestFolder(user.workspaceId, user.id);
    expect(folder.id).toBeTruthy();
    expect(folder.name).toBe('Test Folder');
  });

  it('createTestPage creates a page in a workspace', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.workspaceId, user.id);
    expect(page.id).toBeTruthy();
    expect(page.title).toBe('Test Page');
  });

  it('createTestComment and createTestReply create nested comments', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.workspaceId, user.id);
    const comment = await createTestComment(page.id, user.id);
    expect(comment.content).toBe('Test comment');

    const reply = await createTestReply(comment.id, user.id);
    expect(reply.content).toBe('Test reply');
  });

  it('createTestVersion creates a version for a page', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.workspaceId, user.id);
    const version = await createTestVersion(page.id, user.id);
    expect(version.pageId).toBe(page.id);
  });

  it('createTestTemplate creates a template in a workspace', async () => {
    const user = await createTestUser();
    const tmpl = await createTestTemplate(user.workspaceId, user.id);
    expect(tmpl.workspaceId).toBe(user.workspaceId);
    expect(tmpl.name).toBe('Test Template');
  });

  it('createTestTag creates a tag in a workspace', async () => {
    const user = await createTestUser();
    const tag = await createTestTag(user.workspaceId);
    expect(tag.workspaceId).toBe(user.workspaceId);
    expect(tag.name).toMatch(/^tag-/);
  });

  it('createTestPageLink creates a backlink between pages', async () => {
    const user = await createTestUser();
    const page1 = await createTestPage(user.workspaceId, user.id);
    const page2 = await createTestPage(user.workspaceId, user.id);
    const link = await createTestPageLink(page1.id, page2.id);
    expect(link.sourcePageId).toBe(page1.id);
    expect(link.targetPageId).toBe(page2.id);
  });

  it('createTestPublicShare creates a share token for a page', async () => {
    const user = await createTestUser();
    const page = await createTestPage(user.workspaceId, user.id);
    const share = await createTestPublicShare(page.id);
    expect(share.pageId).toBe(page.id);
    expect(share.token).toBeTruthy();
  });
});
