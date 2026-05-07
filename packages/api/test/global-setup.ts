import { execSync } from 'node:child_process';
import { createServer } from 'node:net';

const CONTAINER_NAME = 'markdawn-postgres-test';
const BASE_PORT = 5433;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => resolve(BASE_PORT));
      }
    });
    server.on('error', reject);
  });
}

async function waitForContainer(name: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      execSync(`podman exec ${name} pg_isready -U markdawn`, {
        stdio: 'pipe',
        timeout: 5_000,
      });
      return;
    } catch {
      if (i >= 5 && i % 10 === 0) {
        try {
          execSync(`podman logs --tail=5 ${name}`, { stdio: 'inherit' });
        } catch {
          void 0;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try {
    execSync(`podman logs --tail=20 ${name}`, { stdio: 'inherit' });
  } catch {
    void 0;
  }
  throw new Error('PostgreSQL test container failed to become ready');
}

export default async function setup(): Promise<() => Promise<void>> {
  // Find a free port to avoid collisions with other test runs or local services
  const port = await findFreePort();
  const testDbUrl = `postgresql://markdawn:password@localhost:${port}/markdawn_test`;

  // Defensive cleanup: remove any leftover container from a previous interrupted run
  try {
    execSync(`podman rm -f ${CONTAINER_NAME} 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    void 0;
  }

  // Start the container with --replace for idempotent startup
  execSync(
    `podman run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=markdawn -e POSTGRES_PASSWORD=password -e POSTGRES_DB=markdawn_test -p ${port}:5432 postgres:17-alpine -c fsync=off -c full_page_writes=off -c synchronous_commit=off`,
    { stdio: 'inherit' },
  );

  await waitForContainer(CONTAINER_NAME);

  // Seed env vars for test worker processes
  process.env.BETTER_AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3001';
  process.env.FRONTEND_URL ??= 'http://localhost:3001';
  process.env.GITHUB_CLIENT_ID ??= 'test';
  process.env.GITHUB_CLIENT_SECRET ??= 'test';
  process.env.GOOGLE_CLIENT_ID ??= 'test';
  process.env.GOOGLE_CLIENT_SECRET ??= 'test';
  process.env.DATABASE_URL = testDbUrl;

  execSync('pnpm exec drizzle-kit push --force', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDbUrl },
    stdio: 'inherit',
  });

  return async () => {
    try {
      execSync(`podman rm -f ${CONTAINER_NAME}`, { stdio: 'pipe', timeout: 15_000 });
    } catch {
      void 0;
    }
  };
}
