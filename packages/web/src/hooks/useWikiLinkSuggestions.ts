import type { Editor } from '@milkdown/core';
import { editorViewCtx } from '@milkdown/core';
import { useQueryClient } from '@tanstack/react-query';
import { Selection } from 'prosemirror-state';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreatePage, usePages } from './use-pages';

type WikiLinkPage = {
  id: string;
  title: string;
  icon: string | null;
};

interface SuggestionsState {
  isOpen: boolean;
  query: string;
  position: { x: number; y: number } | null;
  isLoading: boolean;
}

export function useWikiLinkSuggestions(
  workspaceId: string,
  editorRef: React.RefObject<Editor | null>,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createPageMutation = useCreatePage();
  const { data: allPages = [] } = usePages(workspaceId);

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

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
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
              wikiLinkNode.create({
                path: page.title,
                label: page.title,
              }),
            );

            const nextPos = start + 1;
            const $pos = tr.doc.resolve(nextPos);
            tr.setSelection(Selection.near($pos));

            dispatch(tr);
            view.focus();

            setTimeout(() => {
              queryClient.invalidateQueries({ queryKey: ['backlinks'] });
              queryClient.invalidateQueries({ queryKey: ['outgoingLinks'] });
            }, 1000);
          }
        }
      });

      setSuggestions((prev) => ({ ...prev, isOpen: false }));
    },
    [editorRef, queryClient],
  );

  const handleAddPage = useCallback(
    async (title: string) => {
      createPageMutation.mutate(
        { workspaceId, title: title || 'Untitled' },
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
    [workspaceId, createPageMutation, handleWikiLinkSelect],
  );

  return {
    suggestions,
    allPages,
    handleWikiLinkSuggest,
    handleWikiLinkSelect,
    handleAddPage,
    closeSuggestions: () => setSuggestions((prev) => ({ ...prev, isOpen: false })),
  };
}
