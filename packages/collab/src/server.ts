import { Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import { extractWikilinks, yDocToMarkdown } from '@markdawn/shared/yjs-helpers';
import type { Pool } from 'pg';
import * as Y from 'yjs';
import { parseCookies } from './utils';

async function updateBacklinks(pool: Pool, pageId: string, ydocUpdate: Uint8Array, logger: Logger) {
  try {
    const markdown = yDocToMarkdown(ydocUpdate);
    const links = extractWikilinks(markdown);

    const uniqueTitles = [...new Set(links.map((l) => l.page.toLowerCase()))];
    if (uniqueTitles.length === 0) {
      await pool.query('delete from page_links where source_page_id = $1', [pageId]);
      return;
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const titleToId = new Map<string, string | null>();

    const pageResult = await pool.query('select workspace_id from pages where id = $1', [pageId]);
    const workspaceId: string | null = pageResult.rows[0]?.workspace_id ?? null;

    const uuidTargets: string[] = [];
    const titleTargets: string[] = [];
    for (const title of uniqueTitles) {
      if (uuidRegex.test(title)) {
        uuidTargets.push(title);
      } else {
        titleTargets.push(title);
      }
    }

    if (uuidTargets.length > 0) {
      const result = await pool.query(
        'select id from pages where lower(id::text) = any($1::text[]) and is_deleted = false',
        [uuidTargets],
      );
      for (const row of result.rows) {
        titleToId.set(row.id.toLowerCase(), row.id);
      }
    }

    if (titleTargets.length > 0) {
      const params: unknown[] = [titleTargets];
      let query =
        'select id, title from pages where lower(title) = any($1::text[]) and is_deleted = false';
      if (workspaceId) {
        query += ' and workspace_id = $2';
        params.push(workspaceId);
      }
      const result = await pool.query(query, params);
      for (const row of result.rows) {
        titleToId.set(row.title.toLowerCase(), row.id);
      }
    }

    const placeholders: string[] = [];
    const linkParams: (string | null)[] = [];
    for (const [i, lowerTitle] of uniqueTitles.entries()) {
      const firstLink = links.find((l) => l.page.toLowerCase() === lowerTitle);
      const originalTitle = firstLink?.page ?? lowerTitle;
      const alias = firstLink?.alias ?? originalTitle;
      const targetPageId = titleToId.get(lowerTitle) ?? null;
      const base = 2 + i * 4;
      placeholders.push(`($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3})`);
      linkParams.push(targetPageId, originalTitle, alias, 'wiki');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('delete from page_links where source_page_id = $1', [pageId]);
      await client.query(
        `insert into page_links (source_page_id, target_page_id, target_title, link_text, link_type)
         values ${placeholders.join(',')}
         on conflict (source_page_id, target_title) do update set
           target_page_id = excluded.target_page_id,
           link_text = excluded.link_text,
           link_type = excluded.link_type`,
        [pageId, ...linkParams],
      );
      await client.query('COMMIT');
      logger.debug(`[backlinks] updated ${uniqueTitles.length} links for page ${pageId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`[backlinks] failed to update for page ${pageId}: ${err}`);
  }
}

async function persistDocument(
  pool: Pool,
  documentName: string,
  state: Uint8Array,
  logger: Logger,
) {
  await pool.query('update pages set ydoc = $1, updated_at = NOW() where id = $2', [
    state,
    documentName,
  ]);
  await updateBacklinks(pool, documentName, state, logger);
}

export interface CollabServerConfig {
  port: number;
  pool: Pool;
  logger: Logger;
  debounceMs?: number;
  maxDebounceMs?: number;
}

export function createCollabServer(config: CollabServerConfig) {
  const { port, pool, logger, debounceMs = 500, maxDebounceMs = 3000 } = config;

  async function assertPageAccess(documentName: string, userId: string): Promise<void> {
    const access = await pool.query(
      `SELECT 1 FROM pages p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
       WHERE p.id = $1 AND wm.user_id = $2
       LIMIT 1`,
      [documentName, userId],
    );
    if (access.rows.length === 0) {
      logger.debug(`[auth] user=${userId} denied access to page=${documentName}`);
      throw new Error('Forbidden');
    }
  }

  const server = new Server({
    port,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: async ({ token, requestHeaders, documentName }) => {
      const cookies = parseCookies(requestHeaders.cookie);
      const bearerTokenHeader = requestHeaders.authorization;
      const bearerMatch = bearerTokenHeader?.match(/^Bearer\s+(.+)$/i);
      const bearerToken = bearerMatch?.[1]?.trim() ?? '';
      const tokenFromParam = token?.trim() ?? '';
      const tokenFromCookie =
        cookies.get('better-auth.session_token')?.trim() ||
        cookies.get('__Secure-better-auth.session_token')?.trim() ||
        '';
      const sessionToken = tokenFromParam || bearerToken || tokenFromCookie || '';

      if (!sessionToken) {
        logger.debug('[auth] no session token provided');
        throw new Error('Unauthorized');
      }

      const result = await pool.query(
        `select users.id, users.email, users.name, users.avatar_url as "avatarUrl"
         from sessions
         join users on users.id = sessions.user_id
         where sessions.token = $1 and sessions.expires_at > NOW()
         limit 1`,
        [sessionToken],
      );

      const user = result.rows[0] as
        | { id: string; email: string; name: string; avatarUrl: string | null }
        | undefined;
      if (!user) {
        logger.debug('[auth] invalid/expired session');
        throw new Error('Unauthorized');
      }

      if (documentName) {
        const pageExists = await pool.query('SELECT 1 FROM pages WHERE id = $1 LIMIT 1', [
          documentName,
        ]);
        if (pageExists.rows.length > 0) {
          await assertPageAccess(documentName, user.id);
        }
      }

      logger.info(`[auth] authenticated user=${user.id} (${user.email})`);
      return { user };
    },
    onLoadDocument: async ({ documentName, document, context }) => {
      const user = (context as { user?: { id: string } } | undefined)?.user;
      if (!user) {
        throw new Error('Unauthorized');
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(documentName)) {
        logger.debug(`Invalid document UUID format: ${documentName}`);
        return undefined;
      }

      const result = await pool.query('select ydoc from pages where id = $1', [documentName]);

      if (result.rows.length === 0) {
        logger.info(`New document: ${documentName}`);
        return undefined;
      }

      const ydoc = result.rows[0]?.ydoc as Buffer | undefined;
      if (!ydoc || ydoc.length === 0) {
        return undefined;
      }

      logger.debug(`Loading document: ${documentName}, size: ${ydoc.length} bytes`);
      Y.applyUpdate(document, new Uint8Array(ydoc));
    },
    onStoreDocument: async (data) => {
      const documentName = data.documentName;
      const user = (data.context as { user?: { id: string } } | undefined)?.user;
      if (!user) {
        throw new Error('Unauthorized');
      }

      const state = Y.encodeStateAsUpdate(data.document);
      if (!state || state.length === 0) {
        logger.debug(`[persist] skipping empty state: ${documentName}`);
        return;
      }

      logger.info(`[persist] saving: "${documentName}", size: ${state.length} bytes`);
      try {
        await persistDocument(pool, documentName, state, logger);
        logger.debug(`[persist] saved: ${documentName}`);
      } catch (err) {
        logger.error(`[persist] failed to save "${documentName}": ${err}`);
        throw err;
      }
    },
    onDisconnect: async ({ documentName, instance }) => {
      const doc = instance.documents.get(documentName) as Y.Doc | undefined;
      if (!doc) {
        return;
      }

      const state = Y.encodeStateAsUpdate(doc);
      if (!state || state.length === 0) {
        return;
      }

      logger.info(`[disconnect] force saving: ${documentName}, ${state.length} bytes`);
      try {
        await persistDocument(pool, documentName, state, logger);
        logger.debug(`[disconnect] force saved: ${documentName}`);
      } catch (err) {
        logger.error(`[disconnect] force save failed for "${documentName}": ${err}`);
      }
    },
    extensions: [],
  });

  return server;
}
