import { execSync } from 'node:child_process';
import { createServer } from 'node:net';

const CONTAINER_NAME = 'markdawn-postgres-test-collab';
const BASE_PORT = 5435;

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
  const port = await findFreePort();
  const testDbUrl = `postgresql://markdawn:password@localhost:${port}/markdawn_test`;

  try {
    execSync(`podman rm -f ${CONTAINER_NAME} 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    void 0;
  }

  execSync(
    `podman run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=markdawn -e POSTGRES_PASSWORD=password -e POSTGRES_DB=markdawn_test -p ${port}:5432 postgres:17-alpine -c fsync=off -c full_page_writes=off -c synchronous_commit=off`,
    { stdio: 'inherit' },
  );

  await waitForContainer(CONTAINER_NAME);

  process.env.DATABASE_URL = testDbUrl;
  process.env.COLLAB_PORT ??= '0';
  process.env.BETTER_AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';
  process.env.BETTER_AUTH_URL ??= 'http://localhost:3001';
  process.env.GITHUB_CLIENT_ID ??= 'test';
  process.env.GITHUB_CLIENT_SECRET ??= 'test';

  // Create stub tables so migration 0005's data migration doesn't fail on a fresh DB.
  execSync(`podman exec -i ${CONTAINER_NAME} psql -U markdawn -d markdawn_test`, {
    input: `
        CREATE TABLE IF NOT EXISTS page_links (
          source_page_id uuid, target_page_id uuid, target_title text,
          link_type text, link_text text, created_at timestamp DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS page_tags (page_id uuid, tag_id uuid);
        CREATE TABLE IF NOT EXISTS tags (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid, name text NOT NULL, created_at timestamp DEFAULT now()
        );
      `,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  // Apply the full migration chain (0000–0016) through drizzle-kit.
  execSync('pnpm --filter @markdawn/api exec drizzle-kit migrate', {
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
