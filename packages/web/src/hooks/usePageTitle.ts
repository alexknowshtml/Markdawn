import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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

export function usePageTitle(pageId?: string, initialTitle?: string) {
  const [title, setTitle] = useState(initialTitle ?? 'Untitled');
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof initialTitle === 'string') {
      setTitle(initialTitle);
    }
  }, [initialTitle]);

  const mutation = useMutation({
    mutationFn: (nextTitle: string) => updatePageTitle(pageId!, nextTitle),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pageTree'] });
    },
  });

  useEffect(() => {
    if (!pageId) {
      return undefined;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      mutation.mutate(title.trim().length > 0 ? title : 'Untitled');
    }, 1000);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [mutation, pageId, title]);

  return { title, setTitle };
}
