# AGENTS.md — deploy/

## Gotchas

1. **Quadlet files** go in `~/.config/containers/systemd/` (not system-wide)
2. **Pod naming**: `markdawn.pod` must exist before containers that reference it
3. **Entry points**:
   - API: `node /app/packages/api/dist/index.mjs`
   - Collab: `node /app/packages/collab/dist/index.js`
4. **SPA serving**: API container does NOT serve static files. Caddy serves `packages/web/dist` directly.
5. **PostgreSQL in pod**: port 5432 mapped to `127.0.0.1:5432`. Containers connect via `localhost:5432`.
6. **db:push after restart**: run `pnpm --filter @markdawn/api db:push` after service restart to sync schema.
