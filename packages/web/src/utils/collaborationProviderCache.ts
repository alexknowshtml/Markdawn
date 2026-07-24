import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { IdentityLifecycle } from '../contexts/IdentityLifecycleContext';

type PageProviderCacheEntry = {
  identityLifecycle: IdentityLifecycle;
  pageId: string;
  provider: HocuspocusProvider;
};

// React Strict Mode can evaluate a memo factory twice before committing. A
// provider discarded by that process would otherwise leak a second socket for
// the same Y.Doc/client ID.
const pageProvidersByDocument = new WeakMap<Y.Doc, PageProviderCacheEntry>();

export function getOrCreatePageProvider(
  doc: Y.Doc,
  pageId: string,
  identityLifecycle: IdentityLifecycle,
  create: () => HocuspocusProvider,
): HocuspocusProvider {
  const cached = pageProvidersByDocument.get(doc);
  if (
    cached?.pageId === pageId &&
    cached.identityLifecycle === identityLifecycle &&
    cached.provider.isAttached
  ) {
    return cached.provider;
  }

  const provider = create();
  pageProvidersByDocument.set(doc, { identityLifecycle, pageId, provider });
  return provider;
}
