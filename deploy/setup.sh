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

echo -e "${YELLOW}[STEP 3/7] Cloning repository...${NC}"
sudo mkdir -p /var/www
sudo chown "$(whoami):$(whoami)" /var/www
git clone https://github.com/atharva-again/markdawn.git /var/www/markdawn
cd /var/www/markdawn

echo -e "${YELLOW}[STEP 4/7] Installing Node.js and pnpm...${NC}"
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo dnf install -y nodejs
corepack enable

echo -e "${YELLOW}[STEP 5/7] Configuring environment...${NC}"
cp .env.production .env
nano .env

echo -e "${YELLOW}[STEP 6/7] Building application...${NC}"
pnpm install
pnpm --filter @markdawn/shared build
pnpm --filter @markdawn/web build
pnpm --filter @markdawn/api build
pnpm --filter @markdawn/collab build

echo -e "${YELLOW}[STEP 7/7] Setting up Podman Quadlet services...${NC}"
mkdir -p ~/.config/containers/systemd/env

cp /var/www/markdawn/deploy/quadlet/markdawn.pod ~/.config/containers/systemd/
cp /var/www/markdawn/deploy/quadlet/markdawn-api.container ~/.config/containers/systemd/
cp /var/www/markdawn/deploy/quadlet/markdawn-collab.container ~/.config/containers/systemd/

cp /var/www/markdawn/deploy/quadlet/env/markdawn-api.env.example ~/.config/containers/systemd/env/markdawn-api.env
cp /var/www/markdawn/deploy/quadlet/env/markdawn-collab.env.example ~/.config/containers/systemd/env/markdawn-collab.env

echo -e "${YELLOW}Edit the env files and fill in real values:${NC}"
echo "  nano ~/.config/containers/systemd/env/markdawn-api.env"
echo "  nano ~/.config/containers/systemd/env/markdawn-collab.env"
read -rp "Press Enter after editing the env files..."

podman build -t localhost/markdawn-api:latest -f /var/www/markdawn/deploy/Containerfile.api /var/www/markdawn
podman build -t localhost/markdawn-collab:latest -f /var/www/markdawn/deploy/Containerfile.collab /var/www/markdawn

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
