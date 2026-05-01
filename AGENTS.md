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

See `.env.example` for required variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Auth secret (min 32 chars) |
| `GOOGLE_CLIENT_ID` | OAuth Google |
| `GOOGLE_CLIENT_SECRET` | OAuth Google |
| `GITHUB_CLIENT_ID` | OAuth GitHub |
| `GITHUB_CLIENT_SECRET` | OAuth GitHub |
| `BASE_URL` | Frontend URL (used in .env, but code uses hardcoded localhost:5173) |
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

## Important Gotchas

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
