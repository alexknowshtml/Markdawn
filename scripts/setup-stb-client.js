#!/usr/bin/env node
/**
 * Setup a new STB client org + workspace via the Markdawn API.
 *
 * Usage:
 *   node scripts/setup-stb-client.js <config.json>
 *
 * See scripts/setup-stb-client.example.json for config shape.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: node scripts/setup-stb-client.js <config.json>');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  const base = (config.apiUrl ?? 'http://localhost:3000').replace(/\/$/, '');

  // Step 0: Sign in as super admin
  console.log('→ Signing in...');
  const signInRes = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  if (!signInRes.ok) {
    throw new Error(`Sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  }
  const cookie = signInRes.headers.get('set-cookie');
  if (!cookie) throw new Error('No session cookie returned — check credentials');
  console.log('  ✓ Signed in');

  const apiFetch = async (method, urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${method} ${urlPath} → ${res.status}: ${data.message ?? JSON.stringify(data)}`);
    }
    return data;
  };

  // Step 1: Create org
  console.log(`\n→ Creating org "${config.org.name}"...`);
  const org = await apiFetch('POST', '/api/orgs', {
    name: config.org.name,
    slug: config.org.slug ?? undefined,
    ownerEmail: config.org.ownerEmail,
  });
  const orgSlug = org.slug;
  console.log(`  ✓ Org: ${orgSlug} (id: ${org.id})`);

  // Step 2: Create workspace
  console.log(`\n→ Creating workspace "${config.workspace.name}"...`);
  const ws = await apiFetch('POST', `/api/orgs/${orgSlug}/workspaces`, {
    name: config.workspace.name,
    slug: config.workspace.slug ?? undefined,
    visibility: config.workspace.visibility ?? 'private',
  });
  const wsSlug = ws.slug;
  console.log(`  ✓ Workspace: ${wsSlug} (${ws.visibility})`);

  // Steps 3 + 4: Add members to org then workspace
  const members = config.members ?? [];
  if (members.length > 0) {
    console.log(`\n→ Adding ${members.length} member(s)...`);
    for (const member of members) {
      const orgMember = await apiFetch('POST', `/api/orgs/${orgSlug}/members`, {
        email: member.email,
        role: member.orgRole ?? 'member',
      });
      await apiFetch('POST', `/api/orgs/${orgSlug}/workspaces/${wsSlug}/members`, {
        userId: orgMember.userId,
        role: member.wsRole ?? 'editor',
      });
      console.log(`  ✓ ${member.email} — org:${member.orgRole ?? 'member'}, ws:${member.wsRole ?? 'editor'}`);
    }
  }

  // Step 5: Assign existing content
  const folderIds = config.content?.folderIds ?? [];
  const pageIds = config.content?.pageIds ?? [];
  if (folderIds.length > 0 || pageIds.length > 0) {
    console.log(`\n→ Assigning content (${folderIds.length} folder(s), ${pageIds.length} page(s))...`);
    const result = await apiFetch('POST', `/api/orgs/${orgSlug}/workspaces/${wsSlug}/assign`, {
      folderIds,
      pageIds,
    });
    console.log(`  ✓ ${result.foldersUpdated} folder(s), ${result.pagesUpdated} page(s) updated`);
  }

  console.log(`\n✓ Setup complete`);
  console.log(`  Org:       ${base}/api/orgs/${orgSlug}`);
  console.log(`  Workspace: ${base}/api/orgs/${orgSlug}/workspaces/${wsSlug}`);
}

main().catch((err) => {
  console.error('\n✗ Failed:', err.message);
  process.exit(1);
});
