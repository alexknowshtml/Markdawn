import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { PartialBlock } from '@blocknote/core';

const API_BASE = '/api';

type PageResponse = {
  id: string;
  ydoc: number[] | null;
};

async function fetchPage(pageId: string): Promise<PageResponse> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page');
  }
  return res.json();
}

async function savePageContent(pageId: string, ydoc: Uint8Array): Promise<void> {
  const res = await fetch(`${API_BASE}/pages/${pageId}/content`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ydoc: Array.from(ydoc) }),
  });
  if (!res.ok) {
    throw new Error('Failed to save page content');
  }
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function usePageContent(pageId?: string) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textEncoder = useMemo(() => new TextEncoder(), []);
  const textDecoder = useMemo(() => new TextDecoder(), []);

  const { data } = useQuery({
    queryKey: ['pages', 'content', pageId],
    queryFn: () => fetchPage(pageId!),
    enabled: !!pageId,
  });

  const mutation = useMutation({
    mutationFn: (ydoc: Uint8Array) => savePageContent(pageId!, ydoc),
    onSuccess: () => setSaveStatus('saved'),
    onError: () => setSaveStatus('error'),
  });

  const initialContent = useMemo<PartialBlock[] | undefined>(() => {
    if (!data?.ydoc || data.ydoc.length === 0) {
      return undefined;
    }
    try {
      const decoded = textDecoder.decode(new Uint8Array(data.ydoc));
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? (parsed as PartialBlock[]) : undefined;
    } catch {
      return undefined;
    }
  }, [data?.ydoc, textDecoder]);

  const onEditorChange = useCallback(
    (ydoc: Uint8Array) => {
      if (!pageId) {
        return;
      }
      setSaveStatus('saving');
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        mutation.mutate(ydoc);
      }, 2000);
    },
    [mutation, pageId]
  );

  const serializeContent = useCallback(
    (blocks: PartialBlock[]) => textEncoder.encode(JSON.stringify(blocks)),
    [textEncoder]
  );

  return { initialContent, saveStatus, onEditorChange, serializeContent };
}
