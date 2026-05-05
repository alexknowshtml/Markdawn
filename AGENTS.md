# AGENTS.md — Markdawn Development Guide

Markdawn is a collaborative note-taking application built with:
- **Monorepo**: pnpm workspaces with 4 packages (`api`, `web`, `shared`, `collab`)
- **API**: Hono (Node.js), Drizzle ORM, PostgreSQL
- **Web**: React 19, Vite, Tailwind CSS v4, Mantine UI, Milkdown
- **Collab**: Hocuspocus (Yjs-based) for real-time collaboration
- **Auth**: Better Auth with OAuth support

---

## Package Structure

```
packages/
├── api/       # REST API server (Hono, port 3001)
├── web        # Frontend app (Vite, port 5173)
├── shared     # Shared types and utilities
└── collab     # Collaboration server (Hocuspocus, port 1234)
```

---

## Build / Lint / Test Commands

### Root Commands (run from project root)

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all packages in parallel |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Test all packages |
| `pnpm typecheck` | Type-check all packages |

### Package-Specific Commands

**API (`packages/api/`):**
```bash
pnpm --filter @markdawn/api dev        # Start dev server (tsx watch)
pnpm --filter @markdawn/api build      # Build with tsup
pnpm --filter @markdawn/api typecheck   # Type-check
pnpm --filter @markdawn/api lint        # ESLint
pnpm --filter @markdawn/api db:generate # Generate Drizzle migrations
pnpm --filter @markdawn/api db:push     # Push schema to DB
pnpm --filter @markdawn/api db:studio   # Open Drizzle Studio
```

**Web (`packages/web/`):**
```bash
pnpm --filter @markdawn/web dev        # Start Vite dev server
pnpm --filter @markdawn/web build       # Build (tsc + vite)
pnpm --filter @markdawn/web preview     # Preview production build
pnpm --filter @markdawn/web typecheck   # Type-check
pnpm --filter @markdawn/web lint        # ESLint
```

**Running Single E2E Test (Playwright):**
```bash
cd packages/web
npx playwright test e2e/app.spec.ts
npx playwright test e2e/app.spec.ts --grep "test name"
```

**Collab (`packages/collab/`):**
```bash
pnpm --filter @markdawn/collab dev
pnpm --filter @markdawn/collab build
```

---

## Code Style Guidelines

### TypeScript Configuration

The project uses strict TypeScript with these key settings (`tsconfig.base.json`):
- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`

### ESLint Rules (`.eslintrc.cjs`)

- **ERROR**: `@typescript-eslint/no-explicit-any` — `any` is forbidden
- **WARN**: `no-console` — Prefer proper logging
- **RECOMMENDED**: All TypeScript ESLint recommended rules

### Naming Conventions

- **Files**: `camelCase.ts` for utilities, `PascalCase.tsx` for React components
- **Components**: PascalCase (e.g., `EditorHeader.tsx`)
- **Hooks**: `camelCase` with `use` prefix (e.g., `useAuth.ts`)
- **Types/Interfaces**: PascalCase (e.g., `PageRow`)
- **Constants**: SCREAMING_SNAKE_CASE

### Import Style

- **Named imports** preferred over default imports:
  ```typescript
  import { useState, useEffect } from "react";
  import { Hono } from "hono";
  import { HTTPException } from "hono/http-exception";
  ```
- **Relative imports** for internal modules:
  ```typescript
  import { requireAuth } from "../middleware/auth";
  import { pages } from "../db";
  ```

### Error Handling

**API (Hono):**
- Use `HTTPException` from `hono/http-exception` for HTTP errors
- Always return JSON errors with appropriate status codes:
  ```typescript
  throw new HTTPException(400, { message: "workspaceId is required" });
  throw new HTTPException(403, { message: "Forbidden" });
  throw new HTTPException(404, { message: "Page not found" });
  ```
- Global error handler in `app.onError` returns generic 500 for non-HTTP errors

### React Patterns

- **Function components** only (no class components)
- **Hooks**: Use custom hooks for reusable logic (e.g., `useAuth`, `usePages`)
- **Styling**: Tailwind CSS classes with Mantine components
- **Routing**: React Router v7 with nested routes
- **State**: React Query for server state, local state for UI

### Database (Drizzle ORM)

- Schema defined in `packages/api/src/db/schema.ts`
- Raw SQL for complex queries (see `pages.ts` routes)
- Use parameterized queries to prevent SQL injection

### API Route Structure (Hono)

```typescript
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const route = new Hono();

// Middleware applied to all routes
route.use("*", requireAuth);

// Route handlers
route.get("/", async (c) => { ... });
route.post("/", async (c) => { ... });
route.get(":id", async (c) => { ... });

export default route;
```

---

## Environment Variables

See `.env.dev` for required variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Auth secret (min 32 chars) |
| `GOOGLE_CLIENT_ID` | OAuth Google |
| `GOOGLE_CLIENT_SECRET` | OAuth Google |
| `GITHUB_CLIENT_ID` | OAuth GitHub |
| `GITHUB_CLIENT_SECRET` | OAuth GitHub |
| `BASE_URL` | Frontend URL (fallback to `http://localhost:5173` if `FRONTEND_URL` not set) |
| `PORT` | API server port (default 3001) |
| `COLLAB_PORT` | Collab server port (default 1234) |

---

## Key Dependencies

### API
- `hono` — Web framework
- `drizzle-orm` — ORM
- `drizzle-kit` — Migration tool
- `marked` — Markdown parsing

### Web
- `react` / `react-dom` — UI library
- `react-router-dom` — Routing
- `@mantine/core` — UI components
- `@milkdown/core` — Rich text editor
- `@milkdown/plugin-collaboration` — Yjs collab integration
- `better-auth` — Authentication client
- `@tanstack/react-query` — Server state

### Collab
- `@hocuspocus/server` — Yjs server
- `yjs` — CRDT library

---

## Deployment

All deployment configuration lives in `deploy/`:

```
deploy/
├── Containerfile.api          # API container image
├── Containerfile.collab       # Collab container image
├── Caddyfile                  # Reverse proxy config
├── deploy.sh                  # Incremental deployment script
├── setup.sh                   # One-time server bootstrap
└── quadlet/
    ├── markdawn.pod           # Pod definition (shared network)
    ├── markdawn-api.container # API Quadlet service config
    ├── markdawn-collab.container
    └── env/                   # Environment file templates
```

- **setup.sh** — runs once on a fresh server. Installs Podman, clones repo, builds images, starts systemd user services.
- **deploy.sh** — runs on every code update. Pulls, builds, rebuilds container images, restarts services.
- Both containers run in a single Podman pod sharing `localhost` network.
- Caddy serves the SPA directly from `packages/web/dist`. The API container does not serve static files.

## Common Development Tasks

### Adding a New API Route

1. Create route file in `packages/api/src/routes/`
2. Import and mount in `packages/api/src/index.ts`:
   ```typescript
   import newRoute from "./routes/new";
   app.route("/api/new", newRoute);
   ```

### Adding a New Frontend Route

1. Create component in `packages/web/src/routes/`
2. Add route in `packages/web/src/App.tsx`:
   ```tsx
   <Route path="/new" element={<NewPage />} />
   ```

### Database Migrations

```bash
# After changing schema
pnpm --filter @markdawn/api db:generate
pnpm --filter @markdawn/api db:push
```

### Running Full Stack

```bash
pnpm dev  # Starts all packages in parallel
# API: http://localhost:3001
# Web: http://localhost:5173
# Collab: ws://localhost:1234
```

---

## Testing Strategy

- **E2E Tests**: Playwright (`packages/web/e2e/`)
- **No unit tests** currently configured
- To add tests: Use Vitest for unit tests, Playwright for e2e

---

## Commit Message Guidelines

- Use conventional commit format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- Keep subject line under 72 characters
- **DO NOT include AI agent signatures** such as:
  - "Ultraworked with [Sisyphus]"
  - "Co-authored-by: Sisyphus"
  - Any similar attribution to AI assistants
- Focus on describing the change, not who made it
- **Never do unverified commits** - Always verify changes work before committing:
  - Run linting: `pnpm lint`
  - Run type checking: `pnpm typecheck`
  - Build package: `pnpm build`
- **Never do unsigned commits** - All commits must be GPG signed
  - If GPG signing fails with "incorrect passphrase", retry the commit command
  - The passphrase prompt may have been missed or entered incorrectly on first attempt

---

## Important Notes

1. **No `any` allowed** — Type strictly or use `unknown` with proper narrowing
2. **Environment detection**: Use `process.env.NODE_ENV === "production"`
3. **CORS**: Configured in API, allowlist-based in production
4. **Yjs documents**: Stored as binary buffers in PostgreSQL
5. **Milkdown**: Server-side markdown conversion via `marked`

---

## Testing Rollout Conventions

This section documents reusable testing conventions for adding or expanding test coverage
in any monorepo package, avoiding the need to re-derive the approach package by package.

### Package Type Determination

Each package should choose a testing setup based on its dependencies and runtime needs:

| Package | Type | DB Needed? | Config Approach |
|---------|------|-----------|-----------------|
| `@markdawn/api` | **multi-project** | Yes (real Postgres) | `vitest.config.ts` with `test.projects` — unit + integration split |
| `@markdawn/web` | **single-config** | No (jsdom) | `vitest.config.ts` — browser-like environment |  
| `@markdawn/collab` | **single-config** | No | `vitest.config.ts` — standard node environment |
| `@markdawn/shared` | **single-config** | No | `vitest.config.ts` — standard node environment |

Use **multi-project** when your package has tests that require different environments (e.g., unit
tests with threads vs. integration tests with a database container). Use **single-config** when
all tests share the same environment.

### File Naming Conventions

- Unit tests: `*.unit.test.ts` — pure logic, no DB/network/filesystem
- Integration tests: `*.test.ts` — tests that touch DB, network, or filesystem
- Test helpers: `src/test-utils.ts` — shared factory functions for creating test fixtures
- Test harness: `test/` — global setup, setup hooks, environment configuration
- Smoke suites: `src/test-harness/` — focused validation of helper infrastructure

### Factory Pattern

All route-level integration tests should use factories from `src/test-utils.ts` rather than
inline SQL. This keeps test logic readable and avoids duplication. Available factories:

- `createTestUser()` — user + personal workspace + workspace membership
- `createTestSession(userId)` — signed session cookie
- `createTestWorkspace(ownerId)` — non-personal workspace
- `createTestPage(workspaceId, createdBy)` — page within a workspace
- `createTestFolder(workspaceId, createdBy)` — folder within a workspace
- `createTestComment(pageId, userId)` — comment on a page
- `createTestReply(commentId, userId)` — reply to a comment
- `createTestVersion(pageId, createdBy)` — page version snapshot
- `createTestTemplate(workspaceId, createdBy)` — workspace template
- `createTestTag(workspaceId)` — tag within a workspace
- `createTestPageLink(sourcePageId, targetPageId)` — backlink between pages
- `createTestPublicShare(pageId)` — public share token for a page
- `createTestTempDir()` — isolated temp directory for filesystem tests
- `createTestTempFile(dirPath, name, content)` — file within temp dir
- `mockDbError(error)` — one-shot DB failure simulator

### Integration Harness (API-specific)

The API package uses a real PostgreSQL container via Podman for integration testing:

- Container name: `markdawn-postgres-test`
- Port: dynamically allocated to avoid collisions
- Database: truncated between each test (via `SET session_replication_role = replica`)
- Auth: session cookies signed with HMAC-SHA256 in test helpers
- Env vars: propagated from global setup to test workers via `process.env`

### CI Integration

- API tests run in the `test` CI job: unit → integration → coverage
- CI uses `continue-on-error: true` for coverage to avoid blocking PRs on coverage thresholds
- Podman layers are cached between CI runs for faster container startup
- Coverage reports are uploaded as CI artifacts

### Adding Tests to a New Route

1. Create `src/routes/{name}.test.ts`
2. Import `createTestApp` and needed factories from `../test-utils`
3. Start with the auth guard baseline (401 without session, 401 with invalid token)
4. Add happy-path tests for each endpoint
5. Add validation-failure tests (400, 404, 403)
6. Run: `pnpm --filter @markdawn/api exec vitest run --project integration src/routes/{name}.test.ts`

### Extending to Other Packages

When adding testing to `web`, `collab`, or `shared`:

1. Create a `vitest.config.ts` (single-config style initially)
2. Add `test`, `test:watch` scripts to the package's `package.json`
3. Use the API's `src/test-utils.ts` as a pattern for shared factories
4. For packages that don't need a database, skip the integration harness entirely

---

## Frontend Testing Conventions

### Test Type Decision Matrix

| What you're testing | Test type | Why |
|---------------------|-----------|-----|
| Pure utility function | **Unit** (`*.unit.test.ts`) | No React, no DOM, no network |
| Custom hook | **Unit** (`*.test.ts`) | Mock data layer, assert state transitions |
| Component in isolation | **Component** (`*.test.tsx`) | Render with Testing Library, assert user-visible output |
| Component + hook + fetch | **Integration** (`*.test.tsx`) | Use MSW or stubbed fetch, assert full data flow |
| Full page with routing | **E2E** (`e2e/*.spec.ts`) | Playwright only |
| Multi-user collaboration | **E2E** (`e2e/*.spec.ts`) | Requires real browser + WebSocket |

### Frontend Unit/Component Testing

**Framework**: Vitest + jsdom + `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event`

**Environment**: `packages/web/vitest.config.ts` uses `environment: 'jsdom'` with `globals: true`.

**Setup**: `packages/web/src/test/setup.ts` mocks browser APIs not available in jsdom:
- `ResizeObserver`, `PointerEvent`, `matchMedia`
- `navigator.clipboard`, `localStorage`, `requestAnimationFrame`
- `scrollIntoView`, `getComputedStyle`, `DOMRect`

**Cleanup**: Every test file gets automatic cleanup via `afterEach`:
- `@testing-library/react` cleanup
- `localStorage.clear()` + `sessionStorage.clear()`
- `vi.clearAllMocks()` + `vi.restoreAllMocks()`

### Component Testing Patterns

**Preferred**: Test user-visible behavior, not implementation details.

```typescript
// Good: test what the user sees and does
it('creates a new page when submitted', async () => {
  const user = userEvent.setup();
  render(<CreatePageDialog workspaceId="ws1" />);

  await user.type(screen.getByLabelText(/title/i), 'New Page');
  await user.click(screen.getByRole('button', { name: /create/i }));

  await waitFor(() => {
    expect(screen.queryByText('New Page')).toBeInTheDocument();
  });
});
```

**Anti-pattern**: Do not test internal state, hook return values, or DOM structure that users don't see.

```typescript
// Bad: tests implementation details
it('calls useCreatePage with correct args', () => {
  const spy = vi.spyOn(hooks, 'useCreatePage');
  render(<CreatePageDialog workspaceId="ws1" />);
  expect(spy).toHaveBeenCalledWith('ws1');
});
```

### Hook Testing Patterns

**Preferred**: Mock the data layer (`fetch` or API client), not the hook itself.

```typescript
// Good: mock fetch, test hook state transitions
vi.stubGlobal('fetch', vi.fn());

it('fetches pages on mount', async () => {
  (fetch as Mock).mockResolvedValue({
    json: async () => [{ id: 'p1', title: 'Page 1' }],
    ok: true,
  });

  const { result } = renderHook(() => usePages('ws1'), {
    wrapper: createTestQueryClient(),
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toHaveLength(1);
});
```

**Anti-pattern**: Do not mock the hook return value — this tests the mock, not the hook.

```typescript
// Bad: tests nothing useful
vi.mock('../lib/auth-client', () => ({
  authClient: { useSession: () => ({ data: { user: { id: '1' } } }) },
}));
```

### Frontend Factories

Use `packages/web/src/test/factories.ts` for consistent test data:

- `createTestUser()` — user object with id, email, name
- `createTestWorkspace()` — workspace object
- `createTestPage(overrides?)` — page object
- `createTestFolder(overrides?)` — folder object
- `mockApiResponse(endpoint, data, status?)` — stub fetch for endpoint
- `mockApiError(endpoint, status, message?)` — stub fetch error

### E2E Testing Guidelines

**Scope**: E2E tests cover critical user flows that span multiple components and packages:
- Authentication (login, logout, OAuth)
- Workspace CRUD
- Page CRUD + editing + trash/restore
- Real-time collaboration (multi-browser)
- Search and navigation
- Export/import

**Framework**: Playwright

**Browser coverage**:
- PRs: Chromium only (fast feedback)
- Scheduled: Full cross-browser (Chromium, Firefox, WebKit)
- Release: Full cross-browser + mobile viewports

**Auth**: Use `auth.setup.ts` for shared authentication state. E2E tests run with `storageState` pointing to the shared auth file.

**Data isolation**: E2E tests must create their own test data via API calls in `test.beforeEach` or setup, and clean up in `test.afterEach`. Do not share state between tests.

**Flakiness prevention**:
- Prefer `await expect(...).toBeVisible()` over fixed `page.waitForTimeout()`
- Use `data-testid` selectors for unstable text
- Retry configuration: `retries: process.env.CI ? 2 : 0`
- Traces on first retry: `trace: 'on-first-retry'`
- Screenshots on failure: `screenshot: 'only-on-failure'`

### Adding a New Web Test

1. **Hook test**: Create `src/hooks/use{Feature}.test.ts`
   - Mock `fetch` or API client
   - Use `createTestQueryClient()` wrapper
   - Assert loading → success/error states

2. **Component test**: Create `src/components/{Name}.test.tsx`
   - Render with `render()` from Testing Library
   - Use `userEvent.setup()` for interactions
   - Assert user-visible output with screen queries

3. **E2E test**: Create `e2e/{flow}.spec.ts`
   - Start with `test.beforeEach` to navigate and seed data
   - Cover the critical path, edge cases, and error states
   - Clean up in `test.afterEach`

These are critical issues discovered during implementation. Do not try to "fix" these — they are known limitations.

### Milkdown + Strict TypeScript
- **Issue**: Editor types may conflict with strict TypeScript settings
- **Solution**: Use proper type assertions or `unknown` with narrowing
- **Reference**: Milkdown documentation on TypeScript

### Better Auth baseURL
- **Issue**: OAuth redirect fails if baseURL points to wrong URL
- **Solution**: `baseURL` must be the FRONTEND URL (e.g., `http://localhost:5173`), NOT the API server
- **Reference**: Better Auth Issue #5696

### Milkdown Undo/Redo with Collaboration
- **Issue**: Undo/redo may behave unexpectedly with collaboration enabled
- **Solution**: Test and document any issues found

### Tailwind v4 Configuration
- **Issue**: Tailwind v4 uses CSS-first config (`@import "tailwindcss"` + `@theme`), NOT `tailwind.config.js`
- **FOUC Prevention**: Add inline script in `<head>` that reads `localStorage` and applies `dark` class before React hydrates

### Editor Persistence
- **Design Decision**: T11 (manual API save) was replaced by T14 (collaboration persistence)
- **How it works**: HocuspocusProvider handles both real-time sync AND persistence automatically
- **No manual save needed**: Debounce + save happens via the collab provider

### Vite + Collab WebSocket Proxy
- **Dev setup**: Vite proxy handles `/api` (to port 3001) and `/collab` WebSocket (to port 1234)
- **Production**: Hono serves SPA with `serveStatic({ root: './dist/web', isSPA: true })`

### Hono Middleware Order
- **Issue**: CORS middleware must be registered BEFORE routes
- **Solution**: `app.use("*", cors(...))` before any route definitions

### Database Queries
- **Pattern**: Use `pool.query` for API routes instead of Drizzle's `db.select/insert`
- **Reason**: Drizzle type mismatches between root and package installations
- **Reference**: `packages/api/src/routes/pages.ts` uses `pool.query` for all operations

### Code Quality (Known Violations)
These are documented but not fixed:
- Some components missing `dark:` variants (see quality.md)

### Environment Variables for URLs
URLs are parameterized via environment variables:
- `FRONTEND_URL` / `BASE_URL` — API server uses for OAuth redirects
- `VITE_API_URL` — Frontend uses for API calls (default: http://localhost:3001)
- `VITE_COLLAB_URL` — Frontend uses for WebSocket (default: ws://localhost:1234)
- Vite proxy targets are configurable via env vars in vite.config.ts


### Yjs Export Handling
- **Issue**: `ydoc` column stores binary Yjs CRDT data, not plain text
- **Solution**: Use null-byte detection to distinguish text from binary:
  ```typescript
  const hasNullByte = page.ydoc.includes(0);
  if (!hasNullByte) {
    content = new TextDecoder().decode(page.ydoc);
  }
  ```
- **Why**: Yjs binary contains null bytes, plain markdown text does not
- **Reference**: `packages/api/src/routes/export.ts`

### Wiki Links in Milkdown
- **Issue**: Links are marks, not nodes in Milkdown
- **Solution**: Use text with marks format:
  ```typescript
  [{ type: "text", text: linkText, marks: [{ type: "link", attrs: { href } }] }]
  ```
- **Reference**: `packages/web/src/editor/schema.ts`

### API Routes - Use pool.query
- **Issue**: Drizzle has type mismatches between root and package installations
- **Solution**: Use `pool.query` for all API route operations
- **Reference**: `packages/api/src/routes/pages.ts`

## Some Other Things To Keep In Mind

- Each button should have cursor pointer instead of normal one
- No emojis in the codebase
- Never commit without GPG signing
