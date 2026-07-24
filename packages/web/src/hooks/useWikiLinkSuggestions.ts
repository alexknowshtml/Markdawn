import type { Editor } from '@milkdown/core';
import { editorViewCtx } from '@milkdown/core';
import { Selection } from 'prosemirror-state';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCreatePage, usePages } from './use-pages';
import { useAuth } from './useAuth';

type WikiLinkPage = {
  id: string;
  title: string;
  icon: string | null;
};

export function createBoundWikiLinkAttributes(targetId: string): {
  targetId: string;
  path: string;
  label: string;
} {
  return { targetId, path: '', label: '' };
}

interface SuggestionsState {
  isOpen: boolean;
  query: string;
  position: { x: number; y: number } | null;
  isLoading: boolean;
}

export function useWikiLinkSuggestions(
  editorRef: React.RefObject<Editor | null>,
  sourcePageId: string,
) {
  const createPageMutation = useCreatePage();
  const { data: session } = useAuth();
  const { data: accessiblePages = [] } = usePages({ enabled: !!session?.user });
  const sourceOwnerId = accessiblePages.find((page) => page.id === sourcePageId)?.ownerId;
  const allPages = useMemo(() => {
    if (!sourceOwnerId) return [];
    return accessiblePages.filter((page) => page.ownerId === sourceOwnerId);
  }, [accessiblePages, sourceOwnerId]);
  const canAddPage = sourceOwnerId !== undefined && sourceOwnerId === session?.user?.id;

  const [suggestions, setSuggestions] = useState<SuggestionsState>({
    isOpen: false,
    query: '',
    position: null,
    isLoading: false,
  });

  const lockedPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleWikiLinkSuggest = useCallback(
    (
      isOpen: boolean,
      query: string,
      position: { x: number; y: number; top?: number; bottom?: number } | null,
    ) => {
      setSuggestions((prev) => {
        if (isOpen && !prev.isOpen && position) {
          lockedPositionRef.current = position;
        } else if (!isOpen) {
          lockedPositionRef.current = null;
        }

        return {
          ...prev,
          isOpen,
          query,
          position: lockedPositionRef.current,
        };
      });
    },
    [],
  );

  const handleWikiLinkSelect = useCallback(
    (page: WikiLinkPage) => {
      const editor = editorRef.current;
      if (!editor) return;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!view) return;
          const { state, dispatch } = view;
          const { selection } = state;
          const { $from } = selection;

          const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
          const match = textBefore.match(/\[\[([^\]]*)$/);

          if (match) {
            const start = $from.pos - match[0].length;
            const end = $from.pos;

            const wikiLinkNode = state.schema.nodes.wikiLink;
            if (wikiLinkNode) {
              const tr = state.tr.replaceWith(
                start,
                end,
                wikiLinkNode.create(createBoundWikiLinkAttributes(page.id)),
              );

              const nextPos = start + 1;
              const $pos = tr.doc.resolve(nextPos);
              tr.setSelection(Selection.near($pos));

              dispatch(tr);
              view.focus();
            }
          }
        });
      } catch {
        // Editor may have been destroyed
      }

      setSuggestions((prev) => ({ ...prev, isOpen: false }));
    },
    [editorRef],
  );

  const handleAddPage = useCallback(
    async (title: string) => {
      createPageMutation.mutate(
        { title: title || 'Untitled' },
        {
          onSuccess: (newPage) => {
            handleWikiLinkSelect({
              id: newPage.id,
              title: newPage.title,
              icon: newPage.icon,
            });
          },
        },
      );
    },
    [createPageMutation, handleWikiLinkSelect],
  );

  return {
    suggestions,
    allPages,
    handleWikiLinkSuggest,
    handleWikiLinkSelect,
    handleAddPage,
    canAddPage,
    closeSuggestions: () => setSuggestions((prev) => ({ ...prev, isOpen: false })),
  };
}
