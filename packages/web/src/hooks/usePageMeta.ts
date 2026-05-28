import { HocuspocusProvider } from '@hocuspocus/provider';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { authClient } from '../lib/auth-client';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
const META_ROOM_PREFIX = 'page-meta:';

/**
 * Module-level reference to the current pageIndex Y.Map.
 *
 * Set by `usePageMeta` when the meta room connects, read by the
 * wiki link node view to resolve targetId -> current title at render time.
 *
 * An effect-local ID (`effectIdRef`) prevents the cleanup from nulling
 * the map during a user switch.
 */
let _pageIndex: Y.Map<unknown> | null = null;

export function getPageIndexMap(): Y.Map<unknown> | null {
  return _pageIndex;
}

/**
 * Connects to the user meta room (a shared Yjs document indexed by
 * user ID) that contains:
 *   - `pageIndex`: a map of `{ pageId -> { title, icon, parentId, position } }`
 *   - `backlinksVersion`: a map of `{ pageId -> timestamp }` bumped whenever
 *     a page's connections are rebuilt, so clients can refetch backlinks.
 *
 * The meta room is populated server-side by `updatePageMeta()` and
 * `updateBacklinksVersion()` on every page persist.
 */
export function usePageMeta() {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const effectIdRef = useRef(0);

  useEffect(() => {
    if (!userId) return undefined;

    const effectId = ++effectIdRef.current;

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: COLLAB_URL,
      name: `${META_ROOM_PREFIX}${userId}`,
      document: doc,
      token: async () => {
        const s = await authClient.getSession();
        return s.data?.session?.token ?? '';
      },
    });

    const map = doc.getMap('pageIndex');
    _pageIndex = map;

    // Observe backlinksVersion bumps emitted by the collab server after
    // every persist. When a version changes, invalidate TanStack Query
    // for that page's backlinks and outgoing links so the panel refetches.
    const bv = doc.getMap<number>('backlinksVersion');
    const bvObserver = () => {
      queryClient.invalidateQueries({ queryKey: ['backlinks'] });
    };
    bv.observe(bvObserver);

    // Debounced page tree invalidation on pageIndex changes from the collab
    // server, so the sidebar stays in sync across users.
    const pageTreeTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const pageIndexInitialRef = { current: true };
    const pageIndexObserver = () => {
      if (pageIndexInitialRef.current) {
        pageIndexInitialRef.current = false;
        return;
      }
      if (pageTreeTimerRef.current) clearTimeout(pageTreeTimerRef.current);
      pageTreeTimerRef.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      }, 1000);
    };
    map.observe(pageIndexObserver);

    return () => {
      if (effectId === effectIdRef.current) {
        _pageIndex = null;
      }
      if (pageTreeTimerRef.current) clearTimeout(pageTreeTimerRef.current);
      try {
        bv.unobserve(bvObserver);
      } catch {
        // already detached
      }
      try {
        map.unobserve(pageIndexObserver);
      } catch {
        // already detached
      }
      provider.destroy();
      doc.destroy();
    };
  }, [userId, queryClient]);
}
