#!/bin/bash
set -e

REPO_DIR="/var/www/markdawn"

echo "Markdawn Deployment"
echo "==================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd "$REPO_DIR"

MIGRATION_BASELINE="20260708053035_init"
if podman container exists markdawn-postgres; then
    echo -e "${YELLOW}[CHECK] Verifying database migration compatibility...${NC}"
    if ! podman exec markdawn-postgres pg_isready -U markdawn -d markdawn >/dev/null 2>&1; then
        echo -e "${RED}[ERROR] PostgreSQL is unavailable; refusing to modify deployment artifacts.${NC}"
        exit 1
    fi

    HAS_APPLICATION_TABLES=$(podman exec markdawn-postgres psql -U markdawn -d markdawn -Atqc \
        "select (to_regclass('public.users') is not null)::text")
    if [ "$HAS_APPLICATION_TABLES" = "true" ]; then
        HAS_MIGRATION_TABLE=$(podman exec markdawn-postgres psql -U markdawn -d markdawn -Atqc \
            "select (to_regclass('drizzle.__drizzle_migrations') is not null)::text")
        HAS_MIGRATION_NAME_COLUMN=$(podman exec markdawn-postgres psql -U markdawn -d markdawn -Atqc \
            "select exists (select 1 from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations' and column_name = 'name')::text")
        if [ "$HAS_MIGRATION_TABLE" != "true" ] || [ "$HAS_MIGRATION_NAME_COLUMN" != "true" ]; then
            echo -e "${RED}[ERROR] This database predates the current migration baseline.${NC}"
            echo "This release requires a clean database. Follow the legacy reset procedure in docs/deployment_guide.md."
            exit 1
        fi

        HAS_BASELINE=$(podman exec markdawn-postgres psql -U markdawn -d markdawn -Atqc \
            "select exists (select 1 from drizzle.__drizzle_migrations where name = '$MIGRATION_BASELINE')::text")
        if [ "$HAS_BASELINE" != "true" ]; then
            echo -e "${RED}[ERROR] This database does not contain migration baseline $MIGRATION_BASELINE.${NC}"
            echo "This release requires a clean database. Follow the legacy reset procedure in docs/deployment_guide.md."
            exit 1
        fi
    fi
fi

# Validate compatibility before pulling code, replacing Quadlet units, or overwriting image tags.
echo -e "${YELLOW}[STEP 1/6] Pulling latest code...${NC}"
git pull origin master

echo -e "${YELLOW}[STEP 2/6] Installing dependencies...${NC}"
pnpm install

echo -e "${YELLOW}[STEP 3/6] Building packages...${NC}"
pnpm --filter @markdawn/shared build
pnpm --filter @markdawn/web build
pnpm --filter @markdawn/api build
pnpm --filter @markdawn/collab build

echo -e "${YELLOW}[STEP 4/6] Updating Podman Quadlet units...${NC}"
podman volume create postgres-data 2>/dev/null || true
podman volume create markdawn-data 2>/dev/null || true
cp "$REPO_DIR/deploy/quadlet/markdawn.pod" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-postgres.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-api.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-collab.container" ~/.config/containers/systemd/

echo -e "${YELLOW}[STEP 5/6] Rebuilding container images...${NC}"
podman build -t localhost/markdawn-api:latest -f "$REPO_DIR/deploy/Containerfile.api" "$REPO_DIR"
podman build -t localhost/markdawn-collab:latest -f "$REPO_DIR/deploy/Containerfile.collab" "$REPO_DIR"

echo -e "${YELLOW}[STEP 6/6] Restarting services...${NC}"
systemctl --user daemon-reload
systemctl --user stop markdawn-api.service markdawn-collab.service 2>/dev/null || true
systemctl --user restart markdawn-pod.service markdawn-postgres.service

echo -e "${YELLOW}[WAIT] Waiting for PostgreSQL to be ready...${NC}"
for i in {1..30}; do
    if podman exec markdawn-postgres pg_isready -U markdawn -d markdawn >/dev/null 2>&1; then
        echo -e "${GREEN}[OK] PostgreSQL is ready.${NC}"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo -e "${RED}[ERROR] PostgreSQL did not become ready in time.${NC}"
        exit 1
    fi
    sleep 2
done

echo -e "${YELLOW}[SCHEMA] Running database migrations...${NC}"
pnpm --filter @markdawn/api db:migrate

echo -e "${YELLOW}[APP] Starting application services...${NC}"
systemctl --user restart markdawn-api.service markdawn-collab.service

echo -e "${GREEN}[DONE] Deployment complete!${NC}"
echo ""
echo "Check status: systemctl --user status markdawn-postgres.service markdawn-api.service markdawn-collab.service"
echo "API health:   curl https://markdawn.space/api/health"
