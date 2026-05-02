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

# Load PostgreSQL credentials from .env for readiness checks
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-markdawn}"
POSTGRES_DB="${POSTGRES_DB:-markdawn}"

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
cp "$REPO_DIR/deploy/quadlet/markdawn.pod" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-postgres.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-api.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-collab.container" ~/.config/containers/systemd/

echo -e "${YELLOW}[STEP 5/6] Rebuilding container images...${NC}"
podman build -t localhost/markdawn-api:latest -f "$REPO_DIR/deploy/Containerfile.api" "$REPO_DIR"
podman build -t localhost/markdawn-collab:latest -f "$REPO_DIR/deploy/Containerfile.collab" "$REPO_DIR"

echo -e "${YELLOW}[STEP 6/6] Restarting services...${NC}"
systemctl --user daemon-reload
systemctl --user restart markdawn-postgres.service

for i in {1..30}; do
    if podman exec markdawn-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo -e "${GREEN}[OK] PostgreSQL is ready.${NC}"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo -e "${RED}[ERROR] PostgreSQL did not become ready in time.${NC}"
        exit 1
    fi
    sleep 2
done

echo -e "${YELLOW}[SCHEMA] Pushing database schema...${NC}"
pnpm --filter @markdawn/api db:push

systemctl --user restart markdawn-api.service markdawn-collab.service

echo -e "${GREEN}[DONE] Deployment complete!${NC}"
echo ""
echo "Check status: systemctl --user status markdawn-postgres.service markdawn-api.service markdawn-collab.service"
echo "API health:   curl https://markdawn.space/api/health"
