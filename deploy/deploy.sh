#!/bin/bash
set -e

REPO_DIR="/var/www/markdawn"

echo "Markdawn Deployment"
echo "==================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$SKIP_MIGRATION_WARNING" ]; then
  echo -e "${YELLOW}[WARNING] This deploys a fresh local PostgreSQL instance.${NC}"
  echo -e "${YELLOW}          If migrating from Neon, export your data first.${NC}"
  echo ""
fi

dotenv_get() {
  local file="$1"
  local key="$2"
  grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null \
    | sed -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

validate_database_url() {
  local database_url="$1"
  local postgres_user="$2"
  local postgres_db="$3"

  python3 -c 'import sys
from urllib.parse import urlparse, unquote

database_url, expected_user, expected_db = sys.argv[1:4]
parsed = urlparse(database_url)
actual_user = unquote(parsed.username or "")
actual_db = unquote(parsed.path[1:] if parsed.path.startswith("/") else parsed.path)

if actual_user != expected_user:
    print(f"POSTGRES_USER mismatch: DATABASE_URL uses {actual_user or '<empty>'}, expected {expected_user}", file=sys.stderr)
    raise SystemExit(1)

if actual_db != expected_db:
    print(f"POSTGRES_DB mismatch: DATABASE_URL uses {actual_db or '<empty>'}, expected {expected_db}", file=sys.stderr)
    raise SystemExit(1)
' "$database_url" "$postgres_user" "$postgres_db"
}

cd "$REPO_DIR"

if [ -f "$REPO_DIR/.env" ]; then
  POSTGRES_USER="$(dotenv_get "$REPO_DIR/.env" POSTGRES_USER)"
  POSTGRES_DB="$(dotenv_get "$REPO_DIR/.env" POSTGRES_DB)"
  DATABASE_URL="$(dotenv_get "$REPO_DIR/.env" DATABASE_URL)"
fi

POSTGRES_USER="${POSTGRES_USER:-markdawn}"
POSTGRES_DB="${POSTGRES_DB:-markdawn}"

if [ -n "$DATABASE_URL" ]; then
  if ! validate_database_url "$DATABASE_URL" "$POSTGRES_USER" "$POSTGRES_DB"; then
    echo -e "${RED}[ERROR] DATABASE_URL must match POSTGRES_USER and POSTGRES_DB.${NC}"
    exit 1
  fi
fi

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
systemctl --user restart \
  markdawn-pod.service \
  markdawn-postgres.service \
  markdawn-api.service \
  markdawn-collab.service

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

echo -e "${GREEN}[DONE] Deployment complete!${NC}"
echo ""
echo "Check status: systemctl --user status markdawn-postgres.service markdawn-api.service markdawn-collab.service"
echo "API health:   curl https://markdawn.space/api/health"
