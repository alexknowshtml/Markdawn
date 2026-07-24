import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { yjsUpdateTouchesTitle } from './server';

function cloneDocument(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

function captureUpdate(document: Y.Doc, mutate: () => void): Uint8Array {
  const captured: Uint8Array[] = [];
  const listener = (update: Uint8Array) => {
    captured.push(update);
  };
  document.on('update', listener);
  mutate();
  document.off('update', listener);
  if (captured.length === 0) throw new Error('Expected mutation to emit a Yjs update');
  return Y.mergeUpdates(captured);
}

describe('per-update title attribution', () => {
  it('distinguishes root title writes from content-only writes', () => {
    const serverDocument = new Y.Doc();
    const titleWriter = new Y.Doc();
    const contentWriter = new Y.Doc();
    const titleUpdate = captureUpdate(titleWriter, () => {
      titleWriter.getText('title').insert(0, 'Renamed');
    });
    const contentUpdate = captureUpdate(contentWriter, () => {
      contentWriter.getText('content').insert(0, 'Body only');
    });

    expect(yjsUpdateTouchesTitle(serverDocument, titleUpdate)).toBe(true);
    expect(yjsUpdateTouchesTitle(serverDocument, contentUpdate)).toBe(false);
  });

  it('follows inherited parents for continuation inserts and delete sets', () => {
    const serverDocument = new Y.Doc();
    serverDocument.getText('title').insert(0, 'Initial title');
    serverDocument.getText('content').insert(0, 'Initial body');

    const titleWriter = cloneDocument(serverDocument);
    const titleInsert = captureUpdate(titleWriter, () => {
      titleWriter.getText('title').insert(titleWriter.getText('title').length, ' suffix');
    });
    const titleDeleteWriter = cloneDocument(serverDocument);
    const titleDelete = captureUpdate(titleDeleteWriter, () => {
      titleDeleteWriter.getText('title').delete(0, 1);
    });
    const contentWriter = cloneDocument(serverDocument);
    const contentInsert = captureUpdate(contentWriter, () => {
      contentWriter.getText('content').insert(contentWriter.getText('content').length, ' suffix');
    });
    const contentDeleteWriter = cloneDocument(serverDocument);
    const contentDelete = captureUpdate(contentDeleteWriter, () => {
      contentDeleteWriter.getText('content').delete(0, 1);
    });

    expect(yjsUpdateTouchesTitle(serverDocument, titleInsert)).toBe(true);
    expect(yjsUpdateTouchesTitle(serverDocument, titleDelete)).toBe(true);
    expect(yjsUpdateTouchesTitle(serverDocument, contentInsert)).toBe(false);
    expect(yjsUpdateTouchesTitle(serverDocument, contentDelete)).toBe(false);
  });

  it('does not credit connection B content with connection A title change', () => {
    const serverDocument = new Y.Doc();
    serverDocument.getText('title').insert(0, 'Before');
    serverDocument.getText('content').insert(0, 'Body');
    const titleWriter = cloneDocument(serverDocument);
    const contentWriter = cloneDocument(serverDocument);
    const titleUpdate = captureUpdate(titleWriter, () => {
      const title = titleWriter.getText('title');
      title.delete(0, title.length);
      title.insert(0, 'After A');
    });
    const contentUpdate = captureUpdate(contentWriter, () => {
      contentWriter.getText('content').insert(contentWriter.getText('content').length, ' from B');
    });

    expect(yjsUpdateTouchesTitle(serverDocument, titleUpdate)).toBe(true);
    Y.applyUpdate(serverDocument, titleUpdate);
    expect(serverDocument.getText('title').toString()).toBe('After A');
    expect(yjsUpdateTouchesTitle(serverDocument, contentUpdate)).toBe(false);
  });
});
