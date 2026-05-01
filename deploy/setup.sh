#!/bin/bash
set -e

echo "Markdawn Podman Setup"
echo "====================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}[ERROR] Do not run as root. Run as the deploy user.${NC}"
    exit 1
fi

echo -e "${YELLOW}[STEP 1/7] Installing common tools and Podman...${NC}"
sudo dnf install -y git nano curl podman

echo -e "${YELLOW}[STEP 2/7] Enabling lingering for user systemd services...${NC}"
loginctl enable-linger "$(whoami)"

echo -e "${YELLOW}[STEP 3/7] Preparing repository...${NC}"
sudo mkdir -p /var/www
sudo chown "$(whoami):$(whoami)" /var/www

if [ -d ".git" ]; then
    echo -e "${GREEN}[OK] Running from existing repo. Using current directory.${NC}"
    REPO_DIR="$(pwd)"
else
    echo -e "${YELLOW}Cloning repository...${NC}"
    git clone https://github.com/atharva-again/markdawn.git /var/www/markdawn
    REPO_DIR="/var/www/markdawn"
fi

cd "$REPO_DIR"

echo -e "${YELLOW}[STEP 4/7] Installing Node.js and pnpm...${NC}"
sudo dnf install -y nodejs npm
corepack enable

echo -e "${YELLOW}[STEP 5/7] Configuring environment...${NC}"
if [ -f ".env" ]; then
    echo -e "${GREEN}[OK] .env already exists. Skipping creation.${NC}"
else
    cp .env.production .env
    echo -e "${YELLOW}.env created from .env.production. Edit it now:${NC}"
    nano .env
fi

echo -e "${YELLOW}[STEP 6/7] Building application...${NC}"
pnpm install
pnpm --filter @markdawn/shared build
pnpm --filter @markdawn/web build
pnpm --filter @markdawn/api build
pnpm --filter @markdawn/collab build

echo -e "${YELLOW}[STEP 7/7] Setting up Podman Quadlet services...${NC}"
mkdir -p ~/.config/containers/systemd/env

cp "$REPO_DIR/deploy/quadlet/markdawn.pod" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-api.container" ~/.config/containers/systemd/
cp "$REPO_DIR/deploy/quadlet/markdawn-collab.container" ~/.config/containers/systemd/

cp "$REPO_DIR/deploy/quadlet/env/markdawn-api.env.example" ~/.config/containers/systemd/env/markdawn-api.env
cp "$REPO_DIR/deploy/quadlet/env/markdawn-collab.env.example" ~/.config/containers/systemd/env/markdawn-collab.env

echo -e "${YELLOW}Edit the env files and fill in real values:${NC}"
echo "  nano ~/.config/containers/systemd/env/markdawn-api.env"
echo "  nano ~/.config/containers/systemd/env/markdawn-collab.env"
read -rp "Press Enter after editing the env files..."

podman build -t localhost/markdawn-api:latest -f "$REPO_DIR/deploy/Containerfile.api" "$REPO_DIR"
podman build -t localhost/markdawn-collab:latest -f "$REPO_DIR/deploy/Containerfile.collab" "$REPO_DIR"

systemctl --user daemon-reload
systemctl --user enable markdawn-api.service markdawn-collab.service
systemctl --user start markdawn-api.service markdawn-collab.service

echo -e "${GREEN}[DONE] Setup complete!${NC}"
echo ""
echo "Check status: systemctl --user status markdawn-api.service markdawn-collab.service"
echo "View logs:    journalctl --user -u markdawn-api.service -f"
echo "API health:   curl https://markdawn.space/api/health"
echo ""
echo "Future deployments: cd /var/www/markdawn && ./deploy/deploy.sh"
