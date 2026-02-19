import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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

  const { data: page } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => fetchPage(pageId!),
    enabled: !!pageId,
  });

  if (!pageId || !workspaceSlug) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-12 text-zinc-400">
        Page not found.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <EditorHeader
        workspaceSlug={workspaceSlug}
        pageId={pageId}
        initialTitle={page?.title ?? 'Untitled'}
      />
      <Editor pageId={pageId} />
    </div>
  );
}
