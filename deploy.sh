#!/bin/bash
set -e

echo "Markdawn Deployment Script"
echo "=============================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}[ERROR] DATABASE_URL is not set${NC}"
    exit 1
fi

if [ -z "$BETTER_AUTH_SECRET" ]; then
    echo -e "${RED}[ERROR] BETTER_AUTH_SECRET is not set${NC}"
    exit 1
fi

if [ -z "$FRONTEND_URL" ]; then
    echo -e "${RED}[ERROR] FRONTEND_URL is not set${NC}"
    exit 1
fi

cd /var/www/markdawn

export NODE_ENV=production

if [ -f "/var/www/markdawn/.env" ]; then
    set -a
    source /var/www/markdawn/.env
    set +a
    echo -e "${GREEN}[OK] Loaded environment from .env${NC}"
fi

echo -e "${YELLOW}[STEP 1/6] Pulling latest code...${NC}"
git pull origin master

echo -e "${YELLOW}[STEP 2/6] Installing dependencies...${NC}"
pnpm install

echo -e "${YELLOW}[STEP 3/6] Building shared package...${NC}"
pnpm --filter @markdawn/shared build

echo -e "${YELLOW}[STEP 4/6] Building web frontend...${NC}"
pnpm --filter @markdawn/web build

echo -e "${YELLOW}[STEP 5/6] Building API and collab server...${NC}"
pnpm --filter @markdawn/api build
pnpm --filter @markdawn/collab build

echo -e "${YELLOW}[STEP 6/6] Reloading PM2 processes...${NC}"
pm2 reload ecosystem.config.js

echo -e "${GREEN}[DONE] Deployment complete!${NC}"
echo ""
echo "Check status: pm2 status"
echo "View logs:    pm2 logs"
echo "API health:   curl https://markdawn.duckdns.org/api/health"
