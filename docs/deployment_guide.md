# Markdawn Deployment Guide

Single-VPS deployment on Fedora with Caddy reverse proxy, Podman containers, and self-hosted PostgreSQL 17.

## Prerequisites

- Vultr VM with Fedora 44 (4GB RAM minimum)
- Domain or subdomain pointing to VM IP (e.g., `markdawn.space`)
- Caddy installed on the VM
- GitHub and Google OAuth apps configured

## Initial Server Setup

### 1. Install Dependencies

The `setup.sh` script installs everything automatically, but if doing it manually:

```bash
sudo dnf install -y git nano curl podman
curl -fsSL https://fnm.vercel.app/install | bash
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)"
fnm install 24
fnm use 24
corepack enable pnpm
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
POSTGRES_USER=markdawn
POSTGRES_PASSWORD=your-secure-password
POSTGRES_DB=markdawn
DATABASE_URL=postgresql://markdawn:your-secure-password@localhost:5432/markdawn
BETTER_AUTH_SECRET=minimum-32-characters-secret-key
FRONTEND_URL=https://markdawn.space
BASE_URL=https://markdawn.space
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
CORS_ORIGINS=https://markdawn.space
NODE_ENV=production
PORT=3001
COLLAB_PORT=1234
VITE_API_URL=https://markdawn.space
VITE_COLLAB_URL=wss://markdawn.space/collab
```

### 4. Configure OAuth Providers

Register these redirect URLs in your OAuth provider dashboards:

- Google Cloud Console: `https://markdawn.space/api/auth/callback/google`
- GitHub Settings: `https://markdawn.space/api/auth/callback/github`

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
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 7. Start Services with Podman

```bash
./deploy/setup.sh
```

This script will:
1. Install Podman and common tools
2. Enable lingering for user systemd services
3. Create a persistent Podman volume for PostgreSQL
4. Copy Quadlet files to `~/.config/containers/systemd/`
5. Build container images
6. Start PostgreSQL and wait for it to be healthy
7. Run `db:push` to initialize the database schema
8. Start API and Collab systemd user services

### 8. Verify Deployment

```bash
curl https://markdawn.space/api/health
```

Expected response: `{"status":"ok","timestamp":...}`

## Future Deployments

After initial setup, deploy updates with:

```bash
cd /var/www/markdawn
./deploy/deploy.sh
```

The script will:
1. Pull latest code
2. Install dependencies
3. Build all packages
4. Rebuild container images
5. Restart Podman services
6. Push any database schema updates

## Managing Services

```bash
# View status
systemctl --user status markdawn-postgres.service markdawn-api.service markdawn-collab.service

# View logs
journalctl --user -u markdawn-postgres.service -f
journalctl --user -u markdawn-api.service -f
journalctl --user -u markdawn-collab.service -f

# Restart services
systemctl --user restart markdawn-postgres.service
systemctl --user restart markdawn-api.service
systemctl --user restart markdawn-collab.service

# Stop services
systemctl --user stop markdawn-postgres.service markdawn-api.service markdawn-collab.service

# Enable auto-start on boot
systemctl --user enable markdawn-postgres.service markdawn-api.service markdawn-collab.service
```

## Architecture

```
Vultr VPS (Fedora, 4GB RAM)
├── Caddy (systemd, host) -> reverse proxy
├── Podman Pod (markdawn.pod)
│   ├── markdawn-postgres.container (PostgreSQL 17, port 5432)
│   ├── markdawn-api.container (Hono, port 3001)
│   └── markdawn-collab.container (Hocuspocus, port 1234)
└── Persistent Volume: postgres-data
```

All containers run inside a single Podman pod sharing the `localhost` network namespace.
PostgreSQL port 5432 is bound to `127.0.0.1` only (localhost), not exposed externally.

## Troubleshooting

### Caddy fails to get certificate

Ensure port 80 and 443 are open in the Vultr firewall and that the domain resolves to the VM IP.

### Containers fail to start

Check logs:
```bash
journalctl --user -u markdawn-api.service --no-pager
journalctl --user -u markdawn-collab.service --no-pager
```

Verify the environment file exists:
```bash
ls /var/www/markdawn/.env
```

### Database connection errors

Verify `DATABASE_URL` points to `localhost:5432` and does NOT include `sslmode=require`.
Check PostgreSQL is running:

```bash
systemctl --user status markdawn-postgres.service
podman exec markdawn-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

### OAuth login fails

Confirm redirect URLs exactly match what's registered in the provider dashboard (including protocol and trailing slashes).

### Frontend shows blank page

Ensure `VITE_API_URL` and `VITE_COLLAB_URL` are set before building the web package.
