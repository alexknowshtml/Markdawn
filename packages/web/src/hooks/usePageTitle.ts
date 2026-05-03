import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

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

export function usePageTitle(pageId?: string, initialTitle?: string) {
  const [title, setTitle] = useState(initialTitle ?? 'Untitled');
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedTitleRef = useRef('Untitled');

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

  useEffect(() => {
    if (!pageId) {
      return undefined;
    }
    const nextTitle = normalizeTitle(title);

    if (nextTitle === lastSavedTitleRef.current) {
      return undefined;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      mutation.mutate(nextTitle, {
        onSuccess: () => {
          lastSavedTitleRef.current = nextTitle;
        },
      });
    }, 1000);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [mutation, pageId, title]);

  return { title, setTitle };
}
