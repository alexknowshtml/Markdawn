# Markdawn

A collaborative note-taking application with real-time editing capabilities.

## Features

- Real-time collaboration powered by Yjs and Hocuspocus
- Rich text editing with BlockNote editor
- OAuth authentication (Google, GitHub)
- Workspace-based organization
- Dark mode support
- Responsive design

## Monorepo Structure

```
packages/
├── api/       # REST API server (Hono, port 3001)
├── web/       # Frontend app (Vite, port 5173)
├── shared/    # Shared types and utilities
└── collab/    # Collaboration server (Hocuspocus, port 1234)
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 15+

## Setup

### Install Dependencies

```bash
pnpm install
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Auth secret (min 32 chars) |
| `GOOGLE_CLIENT_ID` | OAuth Google |
| `GOOGLE_CLIENT_SECRET` | OAuth Google |
| `GITHUB_CLIENT_ID` | OAuth GitHub |
| `GITHUB_CLIENT_SECRET` | OAuth GitHub |
| `BASE_URL` | Frontend URL |
| `PORT` | API server port (default 3001) |
| `COLLAB_PORT` | Collab server port (default 1234) |

### Database Setup

```bash
pnpm --filter @markdawn/api db:push
```

### Run Development Servers

```bash
pnpm dev
```

This starts all packages in parallel:
- API: http://localhost:3001
- Web: http://localhost:5173
- Collab: ws://localhost:1234

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all packages in development mode |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run all tests |

## Package-Specific Commands

### API

```bash
pnpm --filter @markdawn/api dev          # Start dev server
pnpm --filter @markdawn/api build        # Build for production
pnpm --filter @markdawn/api typecheck    # Type-check
pnpm --filter @markdawn/api lint         # Run ESLint
pnpm --filter @markdawn/api db:generate  # Generate migrations
pnpm --filter @markdawn/api db:push      # Push schema to DB
pnpm --filter @markdawn/api db:studio    # Open Drizzle Studio
```

### Web

```bash
pnpm --filter @markdawn/web dev          # Start Vite dev server
pnpm --filter @markdawn/web build        # Build for production
pnpm --filter @markdawn/web preview      # Preview production build
pnpm --filter @markdawn/web typecheck    # Type-check
pnpm --filter @markdawn/web lint         # Run ESLint
```

### Collab

```bash
pnpm --filter @markdawn/collab dev       # Start dev server
pnpm --filter @markdawn/collab build     # Build for production
```

### Running E2E Tests

```bash
cd packages/web
npx playwright test e2e/app.spec.ts
```

## Tech Stack

### API
- **Hono** - Web framework
- **Drizzle ORM** - Database ORM
- **PostgreSQL** - Database
- **Better Auth** - Authentication

### Web
- **React 19** - UI library
- **Vite** - Build tool
- **Tailwind CSS v4** - Styling
- **Mantine** - UI components
- **BlockNote** - Rich text editor
- **React Query** - Server state

### Collaboration
- **Hocuspocus** - Yjs server
- **Yjs** - CRDT library

## License

This project is licensed under the GNU Affero General Public License v3.0 (or later).

- Self-hosting is free under AGPL terms.
- If you run a modified network service, you must provide corresponding source code to users.

See [LICENSE](LICENSE) for full text.

## Author

Atharva Verma  
atharva.verma18@gmail.com
