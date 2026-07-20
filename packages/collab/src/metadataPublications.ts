import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool, PoolClient } from 'pg';
import type * as Y from 'yjs';
import { CollabAccessError } from './collabErrors';
import {
  getActiveMetaDocuments,
  rebuildPageMetaDocument,
  updateBacklinksVersion,
  updatePageMeta,
} from './pageMetadata';
import type { PageTitleRuntime } from './pageTitleRuntime';
import { broadcastWikiLinkPresentationInvalidation } from './wikiLinkInvalidation';

type QueryExecutor = Pick<PoolClient, 'query'>;

type PageRenamePublicationOptions = {
  hocuspocus: Hocuspocus;
  pool: Pool;
  logger: Logger;
  titles: PageTitleRuntime;
  lockDocumentAccessMutation(documentName: string, executor: QueryExecutor): Promise<void>;
  lockActivePage(documentName: string, executor: QueryExecutor): Promise<string>;
};

/**
 * Owns the complete API-rename reconciliation transaction, including the race
 * with a later collaborative title update.
 */
export function createPageRenamePublication(options: PageRenamePublicationOptions) {
  const { hocuspocus, pool, logger, titles, lockDocumentAccessMutation, lockActivePage } = options;
  return async function publishCanonicalPageRename(pageId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await lockDocumentAccessMutation(pageId, client);
      const titleRevision = await lockActivePage(pageId, client);
      const result = await client.query<{ title: string }>(
        'select title from pages where id = $1 and is_deleted = false',
        [pageId],
      );
      const title = result.rows[0]?.title;
      if (title === undefined) {
        await client.query('rollback');
        logger.debug(`[listen] renamed page ${pageId} is no longer active, skipping`);
        return;
      }

      const activeDocument = hocuspocus.documents.get(pageId) as Document | undefined;
      const previousCanonicalTitle = titles.getCanonical(pageId);
      const preserveLaterCollaborativeTitle =
        activeDocument !== undefined &&
        previousCanonicalTitle !== undefined &&
        activeDocument.getText('title').toString() !== previousCanonicalTitle &&
        titles.getPendingBaseline(pageId) === titleRevision;
      await publishPageRename(hocuspocus, pool, pageId, title, logger, {
        applyToActive: !preserveLaterCollaborativeTitle,
      });
      titles.rememberExternal(pageId, title, preserveLaterCollaborativeTitle);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (error instanceof CollabAccessError) {
        logger.debug(`[listen] renamed page ${pageId} is no longer active, skipping`);
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

export async function rebuildActivePageMetaDocuments(
  hocuspocus: Hocuspocus,
  pool: Pool,
  logger: Logger,
  options: {
    invalidateBacklinks?: boolean;
    bumpAccessVersion?: boolean;
    reconcileTitles?: boolean;
    queryExecutor?: QueryExecutor;
    reconcileActiveTitles?: () => Promise<void>;
  } = {},
): Promise<void> {
  const {
    invalidateBacklinks = true,
    bumpAccessVersion = false,
    reconcileTitles = true,
    queryExecutor = pool,
  } = options;
  const failures: unknown[] = [];
  if (reconcileTitles && options.reconcileActiveTitles) {
    try {
      await options.reconcileActiveTitles();
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to reconcile active page titles: ${error}`);
    }
  }

  for (const [userId, document] of getActiveMetaDocuments(hocuspocus)) {
    try {
      const accessChanged = await rebuildPageMetaDocument(
        queryExecutor,
        userId,
        document,
        logger,
        invalidateBacklinks,
      );
      if (accessChanged && bumpAccessVersion) {
        document.transact(() => {
          const versions = document.getMap<number>('accessVersion');
          versions.set('access', (versions.get('access') ?? 0) + 1);
        });
      }
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to rebuild page metadata for user ${userId}: ${error}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to rebuild canonical page rename state');
  }
}

export async function publishPageRename(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  newTitle: string,
  logger: Logger,
  options: { applyToActive?: boolean } = {},
): Promise<void> {
  const activeDoc = hocuspocus.documents.get(pageId) as Y.Doc | undefined;
  if (activeDoc && options.applyToActive !== false) {
    const beforeTitle = activeDoc.getText('title').toString();
    if (beforeTitle !== newTitle) {
      activeDoc.transact(() => {
        const titleText = activeDoc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, newTitle);
      });
      logger.debug(
        `[listen] pushed rename to active session for page ${pageId}: "${beforeTitle}" -> "${newTitle}"`,
      );
    }
  }

  const results = await Promise.allSettled([
    updatePageMeta(hocuspocus, pool, pageId, logger),
    updateBacklinksVersion(hocuspocus, pool, [pageId], logger),
  ]);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    failures.push(result.reason);
    logger.error(`[listen] failed to publish rename metadata for page ${pageId}: ${result.reason}`);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish rename metadata for ${pageId}`);
  }

  await broadcastWikiLinkPresentationInvalidation(hocuspocus, pool, {
    targetPageIds: [pageId],
  });

  logger.debug(`[listen] updated meta for renamed page ${pageId} -> ${newTitle}`);
}
