# AGENTS.md — @markdawn/api

## Key Decisions

### Use `pool.query` instead of Drizzle's `db.select/insert`

Type mismatches between root and package installations. All route operations use `pool.query`:

```typescript
import { pool } from "../db/connection";
const result = await pool.query(`SELECT * FROM pages WHERE workspace_id = $1`, [workspaceId]);
```

### Yjs Binary Export

The `ydoc` column stores binary Yjs CRDT data. Use null-byte detection to distinguish from plain text:

```typescript
const hasNullByte = page.ydoc.includes(0);
if (!hasNullByte) {
  content = new TextDecoder().decode(page.ydoc);
}
```

## Testing Conventions

### Auth Guard Baseline

Every route test starts with these two cases:
```typescript
it('returns 401 without session', ...)
it('returns 401 with invalid token', ...)
```

### Use Factories from `src/test-utils.ts`

- `createTestUser()` — user + personal workspace + membership
- `createTestSession(userId)` — signed session cookie
- `createTestPage(workspaceId, createdBy)` — page within workspace
- `createTestWorkspace(ownerId)` — non-personal workspace

### Integration Harness

- PostgreSQL container: `markdawn-postgres-test`
- Truncate between tests: `SET session_replication_role = replica`
- Auth: HMAC-SHA256 signed session cookies
