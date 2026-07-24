# Markdawn Server Migration Guide

A runbook for moving a compatible Markdawn deployment from one Linux VM to another.

**Assumptions:** Both servers use Fedora 44 and rootless Podman, DNS is hosted externally, and you have sudo access on both servers.

> [!WARNING]
> This procedure only supports databases containing the current Drizzle v1 migration baseline, `20260708053035_init`. Databases created from the removed legacy migration history cannot be restored into this release and must follow the clean-reset procedure in `deployment_guide.md`.

---

## 1. Verify source compatibility

Run this on the old server before starting the migration:

```bash
podman exec markdawn-postgres psql -U markdawn -d markdawn -Atqc \
  "select exists (
     select 1
     from drizzle.__drizzle_migrations
     where name = '20260708053035_init'
   )"
```

Continue only if the command prints `t`. Do not copy an incompatible legacy database into the new deployment.

## 2. Prepare the new server

Clone the repository and copy the existing environment file before running setup:

```bash
sudo dnf install -y git
sudo mkdir -p /var/www
sudo chown "$USER:$USER" /var/www
git clone https://github.com/atharva-again/Markdawn.git /var/www/markdawn
scp old-server:/var/www/markdawn/.env /var/www/markdawn/.env
cd /var/www/markdawn
./deploy/setup.sh
```

Verify the fresh deployment, then stop its application services before restoring data:

```bash
curl http://localhost:3001/api/health
systemctl --user stop markdawn-api.service markdawn-collab.service
```

## 3. Capture the source data

Stop writes before creating the final database and upload snapshots:

```bash
systemctl --user stop markdawn-api.service markdawn-collab.service
podman exec markdawn-postgres pg_dump -U markdawn -d markdawn \
  --format=custom --no-owner > /tmp/markdawn-db.dump
podman volume export markdawn-data > /tmp/markdawn-data.tar
```

Copy both snapshots to the new server:

```bash
scp /tmp/markdawn-db.dump new-server:/tmp/
scp /tmp/markdawn-data.tar new-server:/tmp/
```

## 4. Restore on the new server

Replace the fresh database contents with the compatible source snapshot and restore uploads:

```bash
cat /tmp/markdawn-db.dump | podman exec -i markdawn-postgres \
  pg_restore -U markdawn -d markdawn --clean --if-exists --no-owner
podman volume import markdawn-data /tmp/markdawn-data.tar
```

Apply any migrations added after the snapshot and restart the application:

```bash
cd /var/www/markdawn
pnpm --filter @markdawn/api db:migrate
systemctl --user start markdawn-api.service markdawn-collab.service
curl http://localhost:3001/api/health
```

## 5. Cut over

1. Point the domain's DNS records to the new server.
2. Restart Caddy to trigger certificate provisioning:
   ```bash
   sudo systemctl restart caddy
   ```
3. Verify the public API and collaborative editing:
   ```bash
   curl https://markdawn.space/api/health
   ```
4. Keep the old server stopped until the new deployment is confirmed healthy.

---

## Gotchas

### Quadlet health commands do not expand shell variables

Use explicit credentials in the PostgreSQL health command:

```ini
HealthCmd=pg_isready -U markdawn -d markdawn
```

### Never use `db:push` on a migrated database

Schema changes must be represented by checked-in migrations and applied with `db:migrate`.

### Podman rootless volumes require SELinux labeling

Keep `:Z` on the PostgreSQL and application volume mounts so container processes can access them.

## Quick reference

| Task | Command |
|------|---------|
| Check services | `systemctl --user status markdawn-postgres.service markdawn-api.service markdawn-collab.service` |
| View API logs | `journalctl --user -u markdawn-api.service -f` |
| View collaboration logs | `journalctl --user -u markdawn-collab.service -f` |
| Restart applications | `systemctl --user restart markdawn-api.service markdawn-collab.service` |
| Check API health | `curl https://markdawn.space/api/health` |
