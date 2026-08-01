#!/usr/bin/env node
/**
 * Setup a new STB client org + workspace via direct DB access.
 * Bypasses the API and session auth — intended for admin use only.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/setup-stb-client.js <config.json>
 *   (DATABASE_URL is loaded from .env if not set in environment)
 *
 * See scripts/setup-stb-client.example.json for config shape.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const crypto = require('node:crypto');

// Load .env from repo root if DATABASE_URL not set
// Walk up from __dirname until we find a .env file
if (!process.env.DATABASE_URL) {
  try {
    let dir = __dirname;
    let envPath = null;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, '.env');
      if (fs.existsSync(candidate)) { envPath = candidate; break; }
      dir = path.dirname(dir);
    }
    if (!envPath) throw new Error('not found');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length && !process.env[key.trim()]) {
        process.env[key.trim()] = rest.join('=').trim();
      }
    }
  } catch { /* no .env, rely on environment */ }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'org';

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: node scripts/setup-stb-client.js <config.json>');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set and .env not found');
    process.exit(1);
  }

  const db = new Client({ connectionString: dbUrl });
  await db.connect();

  try {
    await db.query('BEGIN');

    // Step 1: Create org
    const orgName = config.org.name;
    const orgSlug = config.org.slug || slugify(orgName);
    console.log(`\n→ Creating org "${orgName}" (${orgSlug})...`);

    const existing = await db.query('SELECT id FROM orgs WHERE slug = $1', [orgSlug]);
    if (existing.rows.length > 0) {
      throw new Error(`Org slug "${orgSlug}" already exists (id: ${existing.rows[0].id})`);
    }

    const orgResult = await db.query(
      `INSERT INTO orgs (name, slug, created_at, updated_at)
       VALUES ($1, $2, now(), now()) RETURNING id, name, slug`,
      [orgName, orgSlug],
    );
    const org = orgResult.rows[0];
    console.log(`  ✓ Org created: ${org.slug} (${org.id})`);

    // Add org owner
    if (config.org.ownerEmail) {
      const ownerRow = await db.query(
        `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [config.org.ownerEmail],
      );
      if (!ownerRow.rows[0]) {
        throw new Error(`Owner email not found: ${config.org.ownerEmail}`);
      }
      await db.query(
        `INSERT INTO org_members (org_id, user_id, role, created_at)
         VALUES ($1, $2, 'owner', now())`,
        [org.id, ownerRow.rows[0].id],
      );
      console.log(`  ✓ Org owner: ${config.org.ownerEmail}`);
    }

    // Step 2: Create workspace
    const wsName = config.workspace.name;
    const wsSlug = config.workspace.slug || slugify(wsName);
    const wsVisibility = config.workspace.visibility ?? 'private';
    console.log(`\n→ Creating workspace "${wsName}" (${wsSlug}, ${wsVisibility})...`);

    const wsResult = await db.query(
      `INSERT INTO workspaces (org_id, name, slug, visibility, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4,
         (SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'owner' LIMIT 1),
         now(), now())
       RETURNING id, name, slug, visibility`,
      [org.id, wsName, wsSlug, wsVisibility],
    );
    const ws = wsResult.rows[0];
    console.log(`  ✓ Workspace created: ${ws.slug} (${ws.id})`);

    // Steps 3 + 4: Add members
    const members = config.members ?? [];
    if (members.length > 0) {
      console.log(`\n→ Adding ${members.length} member(s)...`);
      for (const member of members) {
        const userRow = await db.query(
          `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
          [member.email],
        );
        if (!userRow.rows[0]) {
          console.warn(`  ⚠ User not found, skipping: ${member.email}`);
          continue;
        }
        const userId = userRow.rows[0].id;
        const orgRole = member.orgRole ?? 'member';
        const wsRole = member.wsRole ?? 'editor';

        await db.query(
          `INSERT INTO org_members (org_id, user_id, role, created_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [org.id, userId, orgRole],
        );
        await db.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [ws.id, userId, wsRole],
        );
        console.log(`  ✓ ${member.email} — org:${orgRole}, ws:${wsRole}`);
      }
    }

    // Step 5: Assign existing content
    const folderIds = (config.content?.folderIds ?? []).filter((id) => UUID_PATTERN.test(id));
    const pageIds = (config.content?.pageIds ?? []).filter((id) => UUID_PATTERN.test(id));

    if (folderIds.length > 0 || pageIds.length > 0) {
      console.log(`\n→ Assigning content (${folderIds.length} folder(s), ${pageIds.length} page(s))...`);
      let foldersUpdated = 0, pagesUpdated = 0;
      if (folderIds.length > 0) {
        const r = await db.query(
          `UPDATE folders SET workspace_id = $1 WHERE id = ANY($2::uuid[])`,
          [ws.id, folderIds],
        );
        foldersUpdated = r.rowCount ?? 0;
      }
      if (pageIds.length > 0) {
        const r = await db.query(
          `UPDATE pages SET workspace_id = $1 WHERE id = ANY($2::uuid[])`,
          [ws.id, pageIds],
        );
        pagesUpdated = r.rowCount ?? 0;
      }
      console.log(`  ✓ ${foldersUpdated} folder(s), ${pagesUpdated} page(s) updated`);
    }

    await db.query('COMMIT');

    console.log(`\n✓ Setup complete`);
    console.log(`  Org slug:       ${orgSlug}`);
    console.log(`  Workspace slug: ${wsSlug}`);
    console.log(`  Workspace ID:   ${ws.id}`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Failed:', err.message);
  process.exit(1);
});
