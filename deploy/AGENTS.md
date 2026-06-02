# AGENTS.md — deploy/

## Gotchas

1. **Quadlet files** go in `~/.config/containers/systemd/` (not system-wide)
2. **Pod naming**: `markdawn.pod` must exist before containers that reference it
3. **Entry points**:
   - API: `node /app/packages/api/dist/index.mjs`
   - Collab: `node /app/packages/collab/dist/index.js`
4. **SPA serving**: API container does NOT serve static files. Caddy serves `packages/web/dist` directly.
5. **PostgreSQL in pod**: port 5432 mapped to `127.0.0.1:5432`. Containers connect via `localhost:5432`.
6. **Schema sync**: `setup.sh` runs `db:migrate` followed by a `podman exec` to add any columns that aren't covered by migrations (e.g. `properties` on `pages`). No need to run `db:push` manually.
7. **Migration cleanup pending**: Issue [#102](https://github.com/atharva-again/Markdawn/issues/102) tracks two schema gaps that need proper migrations after `feat/share-ui` merges. Until then, `setup.sh` has raw SQL workarounds.
