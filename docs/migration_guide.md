# Markdawn Server Migration Guide

A runbook for moving a Markdawn production deployment from one Linux VM to another.

**Assumptions:** Old and new servers are both Fedora 43, Podman rootless, DNS hosted externally, you have sudo on both.

> **Tracking issue:** [#102](https://github.com/atharva-again/Markdawn/issues/102) — two schema gaps that still need proper migrations.

---

## What moves and what doesn't

| Moves | Stays behind |
|-------|-------------|
| PostgreSQL database (pg_dump / restore) | Container images (rebuilt by `setup.sh`) |
| Uploaded files in `markdawn-data` volume | Quadlet files (copied from repo) |
| `.env` file (secrets, OAuth keys) | Caddy binary + config (installed by `setup.sh`) |
| | Let's Encrypt cert (auto-provisioned after DNS flip) |

---

## Phase 1: Set up the new server

```bash
sudo dnf install -y git
git clone https://github.com/atharva-again/markdawn.git /var/www/markdawn
cd /var/www/markdawn
./deploy/setup.sh
```

This installs everything, builds containers, starts Postgres, runs `db:migrate`, and starts the API and Collab.

### Verify the new server works

```bash
curl http://localhost:3001/api/health
# → {"status":"ok","timestamp":...}
```

---

## Phase 2: Move the data

Do this while the old server is still running.

**Dump the database on the old server:**
```bash
podman exec markdawn-postgres pg_dump -U markdawn -d markdawn --no-owner > /tmp/markdawn-db-dump.sql
```

**Copy uploaded files:**
```bash
podman volume export markdawn-data > /tmp/markdawn-data.tar
```

**Copy both to your laptop, then to the new server:**
```bash
scp old-server:/tmp/markdawn-db-dump.sql /tmp/
scp old-server:/tmp/markdawn-data.tar /tmp/
scp /tmp/markdawn-db-dump.sql new-server:/tmp/
scp /tmp/markdawn-data.tar new-server:/tmp/
scp /tmp/.env new-server:/var/www/markdawn/.env
```

**On the new server, stop the app containers and restore:**
```bash
systemctl --user stop markdawn-api.service markdawn-collab.service
cat /tmp/markdawn-db-dump.sql | podman exec -i markdawn-postgres psql -U markdawn -d markdawn
podman volume import markdawn-data /tmp/markdawn-data.tar
```

**Run migrations and start services:**
```bash
cd /var/www/markdawn
pnpm --filter @markdawn/api db:migrate
# Apply schema fixes not covered by migrations (see #102)
podman exec markdawn-postgres psql -U markdawn -d markdawn \
  -c "ALTER TABLE pages ADD COLUMN IF NOT EXISTS properties jsonb;"
systemctl --user start markdawn-api.service markdawn-collab.service
```

---

## Phase 3: Cut over

1. **Update DNS** — point the A record to the new server's IP
2. **Restart Caddy** to force cert provisioning:
   ```bash
   sudo systemctl restart caddy
   ```
3. **Verify:**
   ```bash
   curl https://markdawn.space/api/health
   # Try opening a page and typing in the browser
   ```
4. **(Optional) Shut down the old server**

---

## Gotchas

### Quadlet `HealthCmd` doesn't expand variables
`HealthCmd=CMD-SHELL pg_isready -U "$POSTGRES_USER"` breaks with `unterminated quoted string`. Hardcode the values:
```
HealthCmd=pg_isready -U markdawn -d markdawn
```

### `db:push` silently covers migration gaps
It syncs schema directly AND updates Drizzle's internal snapshot. Subsequent `drizzle-kit generate` sees no diff and skips creating migrations. Always use `db:migrate` in production.

### Podman rootless needs `:Z` on volume mounts
Without it, container processes can't read mounted files (like `.env`). The Postgres quadlet uses `Volume=postgres-data:/var/lib/postgresql/data:Z` — keep the `:Z`.

### Caddy needs a restart after DNS change
```bash
sudo systemctl restart caddy
```
Without this, you wait up to an hour for the next cert check cycle.

## Quick Reference

| What | Command |
|------|---------|
| Check services | `systemctl --user status markdawn-api.service markdawn-collab.service` |
| View API logs | `journalctl --user -u markdawn-api.service -f` |
| View Collab logs | `journalctl --user -u markdawn-collab.service -f` |
| Restart | `systemctl --user restart markdawn-api.service markdawn-collab.service` |
| API health | `curl https://markdawn.space/api/health` |
| Dump DB | `podman exec markdawn-postgres pg_dump -U markdawn -d markdawn --no-owner > dump.sql` |
| Restore DB | `cat dump.sql \| podman exec -i markdawn-postgres psql -U markdawn -d markdawn` |
