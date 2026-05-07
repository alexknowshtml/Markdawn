# AGENTS.md — Markdawn

## Gotchas

1. **Environment detection**: `process.env.NODE_ENV === "production"`
2. **Yjs storage**: binary buffers in PostgreSQL (`pages.ydoc`)
3. **CORS**: allowlist-based in production
4. **Buttons**: `cursor-pointer`
5. **Better Auth baseURL**: must be FRONTEND URL (5173), not API (3001)
6. **API does not serve static files**: Caddy serves `packages/web/dist` directly
7. **Deploy**: configs in `deploy/`, scripts: `setup.sh` (one-time) + `deploy.sh` (incremental)
8. The default branch in this repo is `master`.

## Code Style

- **No `any`** — use `unknown` with narrowing
- **No emojis** in code
- **Named imports** preferred
- **File naming**: `camelCase.ts` utils, `PascalCase.tsx` components, `use*.ts` hooks
- **Strict TypeScript**: `noImplicitReturns`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`

## Commit Messages

- Format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **No AI signatures** (not "Co-authored-by: Sisyphus")
- **Verify before commit**: lint → typecheck → build
- **Always GPG sign** — retry if "incorrect passphrase"
