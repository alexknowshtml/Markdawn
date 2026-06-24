# AGENTS.md — Markdawn

## Gotchas

1. **Environment detection**: `process.env.NODE_ENV === "production"`
2. **Yjs storage**: binary buffers in PostgreSQL (`pages.ydoc`)
3. **CORS**: allowlist-based in production
4. **Buttons**: `cursor-pointer`
5. **Better Auth baseURL**: must be FRONTEND URL (5173), not API (3001)
6. **API does not serve static files**: Caddy serves `packages/web/dist` directly
7. **Deploy**: configs in `deploy/`, scripts: `setup.sh` (one-time) + `deploy.sh` (incremental)
 8. **Migration workflow**:
   - Edit `packages/api/src/db/schema.ts` (the source of truth).
   - Run `db:generate` — Drizzle diffs your schema code against the database snapshots in `drizzle/meta/` and produces a SQL migration in `drizzle/`.
   - **Always use `--name`** for meaningful migration names: `pnpm --filter @markdawn/api exec drizzle-kit generate --name describe_your_change`. Without it, Drizzle generates random placeholder names like `exotic_colleen_wing`.
   - **For custom SQL** (data migrations, idempotent DDL): `pnpm --filter @markdawn/api exec drizzle-kit generate --custom --name describe_your_change`. Write your SQL into the generated file.
   - Run `db:migrate` — applies pending migrations and tracks them in `drizzle.__drizzle_migrations`.
   - **Commit everything Drizzle touched**: the new `.sql` file, `meta/_journal.json`, and `meta/XXXX_snapshot.json`. These must stay in sync as a unit.
   - `db:push` syncs the DB directly from schema code, bypassing migration tracking. Never use `db:push` on a database that has `db:migrate` history — it will break future `db:generate` diffs.
   - For a fresh dev setup or new server: `setup.sh` runs `db:migrate`. No `db:push` or legacy stub tables are needed.
9. The default branch in this repo is `master`.
10. Never run lsp diagnostics. Instead run pnpm typecheck and pnpm format. Iterate until fixed. 

## Code Style

- **No `any`** — use `unknown` with narrowing
- **No emojis** in commit messages or log output (emoji is fine in user-facing content like page icons)
- **Named imports** preferred
- **File naming**: `camelCase.ts` utils, `PascalCase.tsx` components, `use*.ts` hooks
- **Strict TypeScript**: `noImplicitReturns`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`

## Commit Messages

- Format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **No AI signatures** (not "Co-authored-by: Sisyphus")
- **Verify before commit**: lint → typecheck → build
- **Always GPG sign** — retry if "incorrect passphrase"
