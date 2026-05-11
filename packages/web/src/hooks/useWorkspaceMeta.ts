import { HocuspocusProvider } from '@hocuspocus/provider';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { authClient } from '../lib/auth-client';

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
const META_ROOM_PREFIX = 'workspace-meta:';

/**
 * Module-level reference to the current workspace's pageIndex Y.Map.
 *
 * Set by `useWorkspaceMeta` when the meta room connects, read by the
 * wiki link node view to resolve targetId → current title at render time.
 *
 * An effect-local ID (`effectIdRef`) prevents the cleanup from nulling
 * the map during a workspace switch. The ID is bumped inside the effect
 * (not during render), so it's safe under concurrent React — replayed
 * renders can't corrupt it.
 */
let _pageIndex: Y.Map<unknown> | null = null;

export function getPageIndexMap(): Y.Map<unknown> | null {
  return _pageIndex;
}

/**
 * Connects to the workspace meta room (a shared Yjs document indexed by
 * workspace ID) that contains:
 *   - `pageIndex`: a map of `{ pageId → { title, icon, parentId, position } }`
 *   - `backlinksVersion`: a map of `{ pageId → timestamp }` bumped whenever
 *     a page's connections are rebuilt, so clients can refetch backlinks.
 *
 * The meta room is populated server-side by `updateWorkspaceMeta()` and
 * `updateBacklinksVersion()` on every page persist.
 */
export function useWorkspaceMeta(workspaceId: string | undefined) {
  const queryClient = useQueryClient();

  // Effect-local ID bumped inside the effect, not during render.
  // On cleanup, only null _pageIndex when no new effect has started,
  // which is safe under concurrent React (replayed renders can't
  // cause a bump without a committed effect).
  const effectIdRef = useRef(0);

  useEffect(() => {
    if (!workspaceId) return undefined;

    const effectId = ++effectIdRef.current;

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: COLLAB_URL,
      name: `${META_ROOM_PREFIX}${workspaceId}`,
      document: doc,
      token: async () => {
        const session = await authClient.getSession();
        return session.data?.session?.token ?? '';
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
      // Only null _pageIndex when this is the last active effect.
      // On a workspace switch, the new effect bumps the ref first,
      // so this cleanup sees a mismatch and skips nulling.
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
  }, [workspaceId, queryClient]);
}
