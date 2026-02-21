import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketStatus } from '@hocuspocus/provider';
import { Editor } from '../components/editor/Editor';
import { EditorHeader } from '../components/editor/EditorHeader';

const API_BASE = '/api';

type PageResponse = {
  id: string;
  title: string;
};

async function fetchPage(pageId: string): Promise<PageResponse> {
  const res = await fetch(`${API_BASE}/pages/${pageId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch page');
  }
  return res.json();
}

export default function Page() {
  const { pageId, workspaceSlug } = useParams<{ pageId: string; workspaceSlug: string }>();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [collabStatus, setCollabStatus] = useState<WebSocketStatus>(WebSocketStatus.Connecting);

  const { data: page } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => fetchPage(pageId!),
    enabled: !!pageId,
  });

  if (!pageId || !workspaceSlug) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 text-zinc-400 animate-fade-in">
        Page not found.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 animate-fade-in">
      <EditorHeader
        workspaceSlug={workspaceSlug}
        pageId={pageId}
        initialTitle={page?.title ?? 'Untitled'}
        provider={provider}
        collabStatus={collabStatus}
      />
      <Editor key={pageId} pageId={pageId} onProviderReady={setProvider} onStatusChange={setCollabStatus} />
    </div>
  );
}
