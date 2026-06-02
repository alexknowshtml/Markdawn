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

echo -e "${YELLOW}[STEP 1/8] Pulling latest code...${NC}"
git pull origin master

echo -e "${YELLOW}[STEP 2/8] Installing dependencies...${NC}"
pnpm install

echo -e "${YELLOW}[STEP 3/8] Building packages...${NC}"
pnpm --filter @markdawn/shared build
pnpm --filter @markdawn/web build

echo -e "${YELLOW}[STEP 4/8] Updating Podman Quadlet units...${NC}"
podman volume create postgres-data 2>/dev/null || true
podman volume create markdawn-data 2>/dev/null || true
cp "$REPO_DIR/deploy/quadlet/markdawn.pod" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-postgres.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-api.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-collab.container" ~/.config/containers/systemd/

echo -e "${YELLOW}[STEP 5/8] Rebuilding container images...${NC}"
podman build -t localhost/markdawn-api:latest -f "$REPO_DIR/deploy/Containerfile.api" "$REPO_DIR"
podman build -t localhost/markdawn-collab:latest -f "$REPO_DIR/deploy/Containerfile.collab" "$REPO_DIR"

echo -e "${YELLOW}[STEP 6/8] Stopping services before migration...${NC}"
systemctl --user stop markdawn-api.service markdawn-collab.service

echo -e "${YELLOW}[STEP 7/8] Running database migrations...${NC}"
pnpm --filter @markdawn/api db:migrate

echo -e "${YELLOW}[STEP 8/8] Restarting api and collab services...${NC}"
systemctl --user daemon-reload
systemctl --user restart \
  markdawn-api.service \
  markdawn-collab.service

echo -e "${YELLOW}[CHECK] Verifying API is healthy...${NC}"
for i in {1..15}; do
    if curl -sf --max-time 5 "http://127.0.0.1:3001/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}[OK] API is healthy.${NC}"
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo -e "${RED}[ERROR] API health check failed after restart.${NC}"
        exit 1
    fi
    sleep 2
done

DEPLOYED_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') deploy: $DEPLOYED_COMMIT" >> "$REPO_DIR/.deploy-log"

echo -e "${GREEN}[DONE] Deployment complete!${NC}"
echo ""
echo "Deployed commit: $DEPLOYED_COMMIT"
echo "Check status: systemctl --user status markdawn-api.service markdawn-collab.service"
echo "View logs:    journalctl --user -u markdawn-api.service -f"
echo "API health:   curl https://markdawn.space/api/health"
