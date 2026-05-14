# AGENTS.md — E2E Tests (Playwright)

## Running Tests

**Always run from the `e2e/` directory, not the project root:**

```bash
cd e2e
npx playwright test                         # all tests
npx playwright test editor/slash-menu.spec.ts  # single file
```

The config at `e2e/playwright.config.ts` uses relative paths (`./playwright/.auth/user.json`) that resolve correctly only when CWD is `e2e/`.

## Prerequisites

### 1. PostgreSQL

A PostgreSQL container must be running on `localhost:5432` with:
- User: `markdawn`
- Password: `password`
- Database: `markdawn`

The dev container is named `markdawn-postgres-dev`. Start it:

```bash
# From project root
pnpm db:start
```

### 2. Database Schema

Push the schema if not already applied:

```bash
cd packages/api
DATABASE_URL=postgresql://markdawn:password@localhost:5432/markdawn pnpm exec drizzle-kit push --force
```

### 3. Dev Servers

Both API (port 3001) and Vite dev server (port 5173) must be running:

```bash
# From project root — this starts API, collab, and web in parallel
pnpm dev
```

The `.env` file at the project root is loaded automatically by `packages/api/src/env.ts`. Required env vars:

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://markdawn:password@localhost:5432/markdawn` |
| `BETTER_AUTH_SECRET` | (at least 32 chars) |
| `FRONTEND_URL` | `http://localhost:5173` |
| `PORT` | `3001` |
| `NODE_ENV` | `development` |

`TEST_SETUP_TOKEN` is optional — if absent, the token check is skipped.

### 4. Playwright Browsers

```bash
cd e2e
npx playwright install chromium firefox
```

## Auth Setup Gotchas

### How Auth Works

The setup test (`auth.setup.ts`) calls `POST /api/test/setup` which:
1. Creates a test user + personal workspace in the database
2. Updates the workspace slug to `e2e-test-workspace`
3. Creates a signed session cookie
4. Navigates to `/app/e2e-test-workspace/`
5. Saves browser storage state to `e2e/playwright/.auth/user.json`

Subsequent tests load this storage state to be authenticated.

### Stale Test Data

**This is the most common failure.** The test setup endpoint always sets the workspace slug to `e2e-test-workspace`, which is a fixed value. If a previous test run left this slug in the database, new setup requests will fail with a `unique constraint violation` on `workspaces_slug_unique`.

**Fix** — clean stale test data from the dev database:

```bash
podman exec -i markdawn-postgres-dev psql -U markdawn -d markdawn <<'SQL'
BEGIN;
DELETE FROM sessions WHERE user_id IN (SELECT owner_id FROM workspaces WHERE slug = 'e2e-test-workspace');
DELETE FROM workspace_members WHERE workspace_id IN (SELECT id FROM workspaces WHERE slug = 'e2e-test-workspace');
DELETE FROM workspaces WHERE slug = 'e2e-test-workspace');
DELETE FROM users WHERE id NOT IN (SELECT owner_id FROM workspaces);
COMMIT;
SQL
```

Then delete the cached auth state:

```bash
rm -f e2e/playwright/.auth/user.json
```

### Auth File Path

The auth setup writes to `e2e/playwright/.auth/user.json` (using `__dirname`). The config reads from `./playwright/.auth/user.json`. Both resolve to the same absolute path as long as CWD is `e2e/`.

If you see `ENOENT: no such file or directory, open './playwright/.auth/user.json'`, you're likely running from the wrong directory.

## CI vs Local Differences

| Aspect | CI | Local |
|---|---|---|
| PostgreSQL container | `markdawn-postgres-e2e` (fresh each run) | `markdawn-postgres-dev` (persistent) |
| Database state | Empty — schema pushed fresh | Has leftover test data |
| Working directory | `e2e/` | Must be `e2e/` |
| TEST_SETUP_TOKEN | Set to `e2e-test-setup-secret` | Not needed (check skipped) |

## Writing Tests

### Patterns

All existing E2E tests follow this pattern:

```typescript
import { expect, test } from '@playwright/test';
import { createNewPage, focusEditor } from '../fixtures';

test('my test', async ({ page }) => {
  await createNewPage(page);   // navigates to app, creates a new page
  await focusEditor(page);     // clicks on ProseMirror editor
  // ...interact with editor...
  await expect(page.locator('.ProseMirror h1')).toBeVisible();
});
```

### Selectors

- Editor content: `.ProseMirror`
- Slash menu: `[data-testid="slash-menu"]`
- Wiki link suggestions: `[data-testid="wikilink-suggestions"]`
- Floating toolbar buttons: `.floating-toolbar button[title="..."]`
- Page title input: `input[data-testid="page-title"]`
- Headings: `.ProseMirror h1`, `.ProseMirror h2`, etc.
- Bold: `.ProseMirror strong`
- Italic: `.ProseMirror em`
- Blockquote: `.ProseMirror blockquote`
- Bullet list: `.ProseMirror ul`
- Ordered list: `.ProseMirror ol`
- Task list: `.ProseMirror li[data-item-type="task"]`
- Table: `.ProseMirror table`
- Divider: `.ProseMirror hr`

### Slash Menu Specifics

- The slash menu renders as a fixed-position popup with `data-testid="slash-menu"`
- Commands are `<button>` elements inside the menu container
- The first visible item (index 0) is "Paragraph" when no filter is active
- Fuse.js fuzzy search with threshold 0.35 is used for filtering
- Keyboard: ArrowDown/ArrowUp cycle through items; Enter selects; Escape closes
- Click-outside also closes the menu
- After selecting a command, the `/query` text is removed from the editor
- The menu container shows "No matching commands" when the query matches nothing
