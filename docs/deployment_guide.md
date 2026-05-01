# Markdawn Deployment Guide

Single-VPS deployment on Vultr (Fedora 44) with Caddy reverse proxy, PM2 process manager, and Neon PostgreSQL.

## Prerequisites

- Vultr VM with Fedora 44
- Domain or subdomain pointing to VM IP (e.g., `markdawn.duckdns.org`)
- Neon PostgreSQL database
- Caddy installed on the VM
- GitHub and Google OAuth apps configured

## Initial Server Setup

### 1. Install Node.js and pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs
npm install -g pnpm pm2
```

### 2. Clone Repository

```bash
sudo mkdir -p /var/www
sudo chown $USER:$USER /var/www
git clone https://github.com/atharva-again/markdawn.git /var/www/markdawn
cd /var/www/markdawn
```

### 3. Configure Environment

Copy the production template and fill in real values:

```bash
cp .env.production .env
nano .env
```

Required variables:

```bash
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
BETTER_AUTH_SECRET=minimum-32-characters-secret-key
FRONTEND_URL=https://markdawn.duckdns.org
BASE_URL=https://markdawn.duckdns.org
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
CORS_ORIGINS=https://markdawn.duckdns.org
NODE_ENV=production
PORT=3001
COLLAB_PORT=1234
VITE_API_URL=https://markdawn.duckdns.org
VITE_COLLAB_URL=wss://markdawn.duckdns.org/collab
```

### 4. Configure OAuth Providers

Register these redirect URLs in your OAuth provider dashboards:

- Google Cloud Console: `https://markdawn.duckdns.org/api/auth/callback/google`
- GitHub Settings: `https://markdawn.duckdns.org/api/auth/callback/github`

### 5. Build Application

```bash
pnpm install
pnpm --filter @markdawn/shared build
pnpm --filter @markdawn/web build
pnpm --filter @markdawn/api build
pnpm --filter @markdawn/collab build
```

### 6. Configure Caddy

Copy the Caddyfile and reload:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 7. Start Services with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# Run the command PM2 outputs for systemd auto-start
```

### 8. Verify Deployment

```bash
curl https://markdawn.duckdns.org/api/health
```

Expected response: `{"status":"ok","timestamp":...}`

## Future Deployments

After initial setup, deploy updates with:

```bash
cd /var/www/markdawn
./deploy.sh
```

The script will:
1. Pull latest code
2. Install dependencies
3. Build all packages
4. Reload PM2 processes with zero downtime

## Architecture

```
markdawn.duckdns.org
├── /                    → Vite SPA (static files)
├── /api/*              → Hono API (port 3001)
├── /collab             → Hocuspocus WebSocket (port 1234)
└── /assets/*           → Cached for 1 year
```

## Troubleshooting

### Caddy fails to get certificate

Ensure port 80 and 443 are open in the Vultr firewall and that the domain resolves to the VM IP.

### PM2 processes crash on startup

Check logs:
```bash
pm2 logs markdawn-api
pm2 logs markdawn-collab
```

### Database connection errors

Verify `DATABASE_URL` includes `sslmode=require` for Neon.

### OAuth login fails

Confirm redirect URLs exactly match what's registered in the provider dashboard (including protocol and trailing slashes).

### Frontend shows blank page

Ensure `VITE_API_URL` and `VITE_COLLAB_URL` are set before building the web package.
