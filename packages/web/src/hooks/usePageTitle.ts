import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useIdentityLifecycle } from '../contexts/IdentityLifecycleContext';

const API_BASE = '/api';

async function updatePageTitle(
  pageId: string,
  title: string,
  usePublicEndpoint: boolean,
  shareToken: string | null,
  isIdentityActive: () => boolean,
): Promise<void> {
  const request = (path: string) => {
    const query = usePublicEndpoint && shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    return fetch(`${API_BASE}/pages/${path}${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  };
  let res = await request(usePublicEndpoint ? `${pageId}/title` : pageId);
  // Anonymous session detection can settle just after the page renders. If a
  // user commits during that brief window, retry through the edit-link route
  // instead of silently losing the title.
  if (!usePublicEndpoint && res.status === 401) {
    // A request that began for identity A must never retry after identity B
    // has mounted, because the second fetch would otherwise use B's cookies.
    if (!isIdentityActive()) throw new Error('Identity retired during title update');
    res = await request(`${pageId}/title`);
  }
  if (!res.ok) throw new Error('Failed to update title');
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

type UsePageTitleOptions = {
  usePublicEndpoint?: boolean;
  shareToken?: string | null;
};

export function usePageTitle(
  pageId?: string,
  initialTitle?: string,
  ydoc?: Y.Doc | null,
  options: UsePageTitleOptions = {},
) {
  const [title, setTitleState] = useState(initialTitle ?? 'Untitled');
  const queryClient = useQueryClient();
  const identityLifecycle = useIdentityLifecycle();
  const usePublicEndpoint = options.usePublicEndpoint ?? false;
  const shareToken = options.shareToken ?? null;
  const lastSavedTitleRef = useRef('Untitled');
  const hasLocalEditsRef = useRef(false);
  const setTitle = useCallback((value: string) => {
    hasLocalEditsRef.current = true;
    setTitleState(value);
  }, []);
  const ydocRef = useRef(ydoc);
  ydocRef.current = ydoc;

  // Listen for title changes from Yjs (sync from other clients or offline reconnect)
  useEffect(() => {
    if (!ydoc) return undefined;

    const titleText = ydoc.getText('title');
    const observer = () => {
      if (hasLocalEditsRef.current) return;
      const newTitle = titleText.toString() || 'Untitled';
      setTitleState(newTitle);
      lastSavedTitleRef.current = newTitle;
    };
    titleText.observe(observer);

    return () => {
      titleText.unobserve(observer);
    };
  }, [ydoc]);

  useEffect(() => {
    if (typeof initialTitle === 'string' && !hasLocalEditsRef.current) {
      const normalized = normalizeTitle(initialTitle);
      setTitleState(normalized);
      lastSavedTitleRef.current = normalized;
    }
  }, [initialTitle]);

  const mutation = useMutation({
    mutationFn: (nextTitle: string) => {
      if (!pageId) throw new Error('pageId is required');
      return updatePageTitle(
        pageId,
        nextTitle,
        usePublicEndpoint,
        shareToken,
        identityLifecycle.isActive,
      );
    },
    onSuccess: (_data, nextTitle) => {
      queryClient.setQueryData(['pages', 'detail', pageId], (old: unknown) => {
        if (!old || typeof old !== 'object' || Array.isArray(old)) return old;
        return { ...old, title: nextTitle };
      });
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
      queryClient.invalidateQueries({ queryKey: ['shares'] });
    },
  });

  const commitTitle = useCallback(
    (newTitle: string) => {
      const nextTitle = normalizeTitle(newTitle);
      if (nextTitle === lastSavedTitleRef.current) {
        hasLocalEditsRef.current = false;
        return;
      }
      hasLocalEditsRef.current = false;

      // Write to Yjs doc for offline queue and real-time sync
      const currentDoc = ydocRef.current;
      if (currentDoc) {
        const titleText = currentDoc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, nextTitle);
      }

      // Persist through either the authenticated page endpoint or the
      // public-link endpoint. The collaboration update provides immediate
      // feedback while the API write makes the title canonical.
      mutation.mutate(nextTitle, {
        onSuccess: () => {
          lastSavedTitleRef.current = nextTitle;
        },
      });
    },
    [mutation],
  );

  return { title, setTitle, commitTitle };
}
