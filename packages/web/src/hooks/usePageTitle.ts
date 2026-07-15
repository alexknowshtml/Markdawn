import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

const API_BASE = '/api';

async function updatePageTitle(pageId: string, title: string): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error('Failed to update title');
  }
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

type UsePageTitleOptions = {
  persistViaApi?: boolean;
};

export function usePageTitle(
  pageId?: string,
  initialTitle?: string,
  ydoc?: Y.Doc | null,
  options: UsePageTitleOptions = {},
) {
  const [title, setTitle] = useState(initialTitle ?? 'Untitled');
  const queryClient = useQueryClient();
  const persistViaApi = options.persistViaApi ?? true;
  const lastSavedTitleRef = useRef('Untitled');
  const ydocRef = useRef(ydoc);
  ydocRef.current = ydoc;

  // Listen for title changes from Yjs (sync from other clients or offline reconnect)
  useEffect(() => {
    if (!ydoc) return undefined;

    const titleText = ydoc.getText('title');
    const observer = () => {
      const newTitle = titleText.toString() || 'Untitled';
      setTitle(newTitle);
      lastSavedTitleRef.current = newTitle;
    };
    titleText.observe(observer);

    return () => {
      titleText.unobserve(observer);
    };
  }, [ydoc]);

  useEffect(() => {
    if (typeof initialTitle === 'string') {
      const normalized = normalizeTitle(initialTitle);
      setTitle(normalized);
      lastSavedTitleRef.current = normalized;
    }
  }, [initialTitle]);

  const mutation = useMutation({
    mutationFn: (nextTitle: string) => {
      if (!pageId) throw new Error('pageId is required');
      return updatePageTitle(pageId, nextTitle);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
    },
  });

  const commitTitle = useCallback(
    (newTitle: string) => {
      const nextTitle = normalizeTitle(newTitle);
      if (nextTitle === lastSavedTitleRef.current) return;

      // Write to Yjs doc for offline queue and real-time sync
      const currentDoc = ydocRef.current;
      if (currentDoc) {
        const titleText = currentDoc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, nextTitle);
      }

      if (!persistViaApi) {
        // Anonymous edit links persist through the authorized collaboration
        // document. The protected metadata API would reject this fast path.
        if (currentDoc) lastSavedTitleRef.current = nextTitle;
        return;
      }

      // Send PATCH for DB column update (fast-path cache)
      mutation.mutate(nextTitle, {
        onSuccess: () => {
          lastSavedTitleRef.current = nextTitle;
        },
      });
    },
    [mutation, persistViaApi],
  );

  return { title, setTitle, commitTitle };
}
