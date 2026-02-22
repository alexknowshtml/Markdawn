import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketStatus } from '@hocuspocus/provider';
import { Editor } from '../components/editor/Editor';
import { EditorHeader } from '../components/editor/EditorHeader';
import { CoverPicker } from '../components/editor/CoverPicker';
import { CommentsSidebar } from '../components/editor/CommentsSidebar';
import { TemplatesDialog } from '../components/editor/TemplatesDialog';
import { TableOfContents } from '../components/editor/TableOfContents';
import { useUpdatePage } from '../hooks/use-pages';
import { showErrorToast } from "../utils/toast"

import { Button } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';

const API_BASE = '/api';

import { Page as PageType } from '@markdawn/shared';

async function fetchPage(pageId: string): Promise<PageType> {
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
  const [showComments, setShowComments] = useState(false);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const updatePageMutation = useUpdatePage();


  const { data: page } = useQuery({
    queryKey: ['pages', 'detail', pageId],
    queryFn: () => fetchPage(pageId!),
    enabled: !!pageId,
  });

  const handleCoverChange = async (type: string | null, value: string | null) => {
    if (!pageId) return;
    try {
      await updatePageMutation.mutateAsync({
        pageId,
        updates: { coverType: type, coverValue: value },
      });
    } catch (error) {
      console.error('Failed to update cover', error);
      showErrorToast('Failed to update cover');
    }
  };

  if (!pageId || !workspaceSlug) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 text-zinc-400 animate-fade-in">
        Page not found.
      </div>
    );
  }

  return (
    showComments ? (
      <div className="flex h-[calc(100vh-4rem)] animate-fade-in">
        <div className="flex-1 max-w-4xl mx-auto px-6 py-8 md:py-12 overflow-y-auto">
          {page && (
            (page.coverType || page.coverValue) ? (
              <div 
                className="w-full h-[200px] rounded-xl mb-8 relative group overflow-hidden"
                style={{
                  background: page.coverType === 'gradient' ? page.coverValue! : undefined,
                  backgroundColor: page.coverType === 'solid' ? page.coverValue! : undefined,
                }}
              >
                <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                    <TemplatesDialog
                      workspaceId={page.workspaceId!}
                      onUseTemplate={(template) => {
                        if (!editorInstance) {
                          return;
                        }
                        editorInstance.replaceBlocks(editorInstance.document, template.contentBlocks);
                      }}
                    />
                  <CoverPicker coverType={page.coverType} coverValue={page.coverValue} onChange={handleCoverChange}>
                    <Button variant="white" size="sm" leftSection={<IconPhoto size={16} />} className="text-zinc-700 shadow-sm">
                      Change cover
                    </Button>
                  </CoverPicker>
                </div>
              </div>
            ) : (
                            <div className="mb-8 flex justify-end gap-2">
                <TemplatesDialog
                  workspaceId={page.workspaceId!}
                  onUseTemplate={(template) => {
                    if (!editorInstance) {
                      return;
                    }
                    editorInstance.replaceBlocks(editorInstance.document, template.contentBlocks);
                  }}
                />
                <CoverPicker coverType={null} coverValue={null} onChange={handleCoverChange}>
                  <Button variant="subtle" color="gray" size="sm" leftSection={<IconPhoto size={16} />}>
                    Add cover
                  </Button>
                </CoverPicker>
              </div>
            )
          )}

          <EditorHeader
            workspaceSlug={workspaceSlug}
            pageId={pageId}
            initialTitle={page?.title ?? 'Untitled'}
            initialIcon={page?.icon ?? null}
            provider={provider}
            collabStatus={collabStatus}
            showComments={showComments}
            onToggleComments={() => setShowComments(!showComments)}
            showRaw={showRaw}
            onToggleRaw={() => setShowRaw((prev) => !prev)}
            showToc={showToc}
            onToggleToc={() => setShowToc((prev) => !prev)}
            page={page}
          />
          <Editor key={pageId} pageId={pageId} showRaw={showRaw} onProviderReady={setProvider} onStatusChange={setCollabStatus} onEditorReady={setEditorInstance} />
        </div>
        {showToc && editorInstance && (
          <TableOfContents editor={editorInstance} onClose={() => setShowToc(false)} />
        )}
        <CommentsSidebar pageId={pageId!} isOpen={showComments} onClose={() => setShowComments(false)} />
      </div>
    ) : (
      <div className="max-w-4xl mx-auto px-6 py-8 md:py-12 animate-fade-in">
        {page && (
          (page.coverType || page.coverValue) ? (
            <div 
              className="w-full h-[200px] rounded-xl mb-8 relative group overflow-hidden"
              style={{
                background: page.coverType === 'gradient' ? page.coverValue! : undefined,
                backgroundColor: page.coverType === 'solid' ? page.coverValue! : undefined,
              }}
            >
              <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                <TemplatesDialog
                  workspaceId={page.workspaceId!}
                  onUseTemplate={(template) => {
                    if (!editorInstance) {
                      return;
                    }
                    editorInstance.replaceBlocks(editorInstance.document, template.contentBlocks);
                  }}
                />
                <CoverPicker coverType={page.coverType} coverValue={page.coverValue} onChange={handleCoverChange}>
                  <Button variant="white" size="sm" leftSection={<IconPhoto size={16} />} className="text-zinc-700 shadow-sm">
                    Change cover
                  </Button>
                </CoverPicker>
              </div>
            </div>
          ) : (
            <div className="mb-8 flex justify-end gap-2">
              <TemplatesDialog
                workspaceId={page.workspaceId!}
                onUseTemplate={(template) => {
                  if (!editorInstance) {
                    return;
                  }
                  editorInstance.replaceBlocks(editorInstance.document, template.contentBlocks);
                }}
              />
              <CoverPicker coverType={null} coverValue={null} onChange={handleCoverChange}>
                <Button variant="subtle" color="gray" size="sm" leftSection={<IconPhoto size={16} />}>
                  Add cover
                </Button>
              </CoverPicker>
            </div>
          )
        )}

        <EditorHeader
          workspaceSlug={workspaceSlug}
          pageId={pageId}
          initialTitle={page?.title ?? 'Untitled'}
          initialIcon={page?.icon ?? null}
          provider={provider}
          collabStatus={collabStatus}
          showComments={showComments}
          onToggleComments={() => setShowComments(!showComments)}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw((prev) => !prev)}
          showToc={showToc}
          onToggleToc={() => setShowToc((prev) => !prev)}
          page={page}
        />
        <Editor key={pageId} pageId={pageId} showRaw={showRaw} onProviderReady={setProvider} onStatusChange={setCollabStatus} onEditorReady={setEditorInstance} />
        {showToc && editorInstance && (
          <TableOfContents editor={editorInstance} onClose={() => setShowToc(false)} />
        )}
      </div>
    )
  );
}
