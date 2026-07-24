import type { Hocuspocus } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getDocumentContentHash } from './documentContentHash';
import { createDocumentContentLock } from './documentContentLock';
import { reconcileActiveDocumentContent } from './documentContentReconciliation';

function createOptions(stored: Buffer, loaded: Buffer) {
  const blockDocumentForReload = vi.fn();
  const pool = {
    query: vi.fn(async () => ({
      rows: [{ id: '00000000-0000-4000-8000-000000000001', ydoc: stored }],
    })),
  };
  const documents = new Map([['00000000-0000-4000-8000-000000000001', {}]]);
  const contentLock = createDocumentContentLock();
  return {
    options: {
      pool: pool as unknown as Pool,
      hocuspocus: { documents } as unknown as Hocuspocus,
      logger: { info: vi.fn() } as unknown as Logger,
      isMetaRoom: () => false,
      getLoadedContentHash: () => getDocumentContentHash(loaded),
      withDocumentContentLock: contentLock.run,
      blockDocumentForReload,
    },
    blockDocumentForReload,
  };
}

describe('active document content reconciliation', () => {
  it('keeps an active document connected when stored content is unchanged', async () => {
    const state = Buffer.from('same state');
    const { options, blockDocumentForReload } = createOptions(state, state);

    await reconcileActiveDocumentContent(options);

    expect(blockDocumentForReload).not.toHaveBeenCalled();
  });

  it('reloads only an active document whose stored content changed', async () => {
    const { options, blockDocumentForReload } = createOptions(
      Buffer.from('replacement'),
      Buffer.from('loaded state'),
    );

    await reconcileActiveDocumentContent(options);

    expect(blockDocumentForReload).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      4500,
      'Document reload required',
    );
  });

  it('does not reload a document while its own save is updating the content hash', async () => {
    const pageId = '00000000-0000-4000-8000-000000000001';
    const contentLock = createDocumentContentLock();
    let stored = Buffer.from('loaded state');
    let loaded = Buffer.from('loaded state');
    let releaseSave: (() => void) | undefined;
    const saveMayFinish = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveStarted: (() => void) | undefined;
    const saveHasStarted = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const save = contentLock.run(pageId, async () => {
      stored = Buffer.from('saved state');
      saveStarted?.();
      await saveMayFinish;
      loaded = stored;
    });
    await saveHasStarted;

    const blockDocumentForReload = vi.fn();
    const reconciliation = reconcileActiveDocumentContent({
      pool: {
        query: vi.fn(async () => ({ rows: [{ id: pageId, ydoc: stored }] })),
      } as unknown as Pool,
      hocuspocus: { documents: new Map([[pageId, {}]]) } as unknown as Hocuspocus,
      logger: { info: vi.fn() } as unknown as Logger,
      isMetaRoom: () => false,
      getLoadedContentHash: () => getDocumentContentHash(loaded),
      withDocumentContentLock: contentLock.run,
      blockDocumentForReload,
    });

    releaseSave?.();
    await Promise.all([save, reconciliation]);

    expect(blockDocumentForReload).not.toHaveBeenCalled();
  });

  it('reconciles an unrelated document while another document save is blocked', async () => {
    const blockedPageId = '00000000-0000-4000-8000-000000000001';
    const changedPageId = '00000000-0000-4000-8000-000000000002';
    const contentLock = createDocumentContentLock();
    let releaseSave: (() => void) | undefined;
    const saveMayFinish = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveStarted: (() => void) | undefined;
    const saveHasStarted = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const save = contentLock.run(blockedPageId, async () => {
      saveStarted?.();
      await saveMayFinish;
    });
    await saveHasStarted;

    const blockDocumentForReload = vi.fn();
    const reconciliation = reconcileActiveDocumentContent({
      pool: {
        query: vi.fn(async () => ({
          rows: [
            { id: blockedPageId, ydoc: Buffer.from('same') },
            { id: changedPageId, ydoc: Buffer.from('replacement') },
          ],
        })),
      } as unknown as Pool,
      hocuspocus: {
        documents: new Map([
          [blockedPageId, {}],
          [changedPageId, {}],
        ]),
      } as unknown as Hocuspocus,
      logger: { info: vi.fn() } as unknown as Logger,
      isMetaRoom: () => false,
      getLoadedContentHash: (pageId) =>
        getDocumentContentHash(Buffer.from(pageId === blockedPageId ? 'same' : 'loaded')),
      withDocumentContentLock: contentLock.run,
      blockDocumentForReload,
    });

    await vi.waitFor(() => {
      expect(blockDocumentForReload).toHaveBeenCalledWith(
        changedPageId,
        4500,
        'Document reload required',
      );
    });
    releaseSave?.();
    await Promise.all([save, reconciliation]);
  });
});
