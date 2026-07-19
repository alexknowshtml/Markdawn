import {
  COLLAB_TERMINAL_REASONS,
  deriveCapabilities,
  type Page,
  type PageTreeNode,
  type SharePermission,
  shouldApplyPermissionSnapshot,
} from '@markdawn/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIsReadOnly, useSetReadOnly } from '../../contexts/EditorReadOnlyContext';
import {
  type IdentityLifecycle,
  useIdentityLifecycle,
  useIdentityNavigate,
} from '../../contexts/IdentityLifecycleContext';
import { useShortcut } from '../../contexts/KeyboardShortcutContext';
import {
  useSetAccessPermission,
  useSetCapabilities,
  useShareContext,
} from '../../contexts/ShareContext';
import {
  fetchWikiLinkPresentations,
  refreshWikiLinkPresentations,
  registerWikiLinkPresentationResolver,
  type WikiLinkNavigationTarget,
} from '../../editor/wikiLinkPresentations';
import { invalidateWorkspaceAccessQueries } from '../../hooks/use-workspace';
import { useAuth } from '../../hooks/useAuth';
import { useAwareness } from '../../hooks/useAwareness';
import { useFloatingToolbar } from '../../hooks/useFloatingToolbar';
import { useMilkdown } from '../../hooks/useMilkdown';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { useWikiLinkSuggestions } from '../../hooks/useWikiLinkSuggestions';
import { authClient } from '../../lib/auth-client';
import { getLogger } from '../../logger-init';
import { getAnonymousId } from '../../utils/anonymous-cookie';
import { consumeSelfLeave } from '../../utils/leave-page';
import { showInfoToast } from '../../utils/toast';
import { buildFolderPath, ensureAbsoluteUrl } from '../../utils/url';
import './editor.css';
import {
  HocuspocusProvider,
  type onAuthenticationFailedParameters,
  type onCloseParameters,
  WebSocketStatus,
} from '@hocuspocus/provider';
import type { Editor } from '@milkdown/core';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
} from 'prosemirror-tables';
import * as Y from 'yjs';
import { FloatingToolbar } from './FloatingToolbar';
import { getClosestListType, switchListType, unwrapList, wrapBlocksInList } from './listCommands';
import { SlashMenu } from './SlashMenu';
import { WikiLinkSuggestions } from './WikiLinkSuggestions';

interface MilkdownEditorProps {
  pageId: string;
  initialValue?: string;
  onChange?: (markdown: string) => void;
  onProviderReady?: (provider: HocuspocusProvider) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
  onWikiLinkClick?: (target: WikiLinkNavigationTarget) => void;
  onPermissionSnapshot?: (permission: SharePermission | null, accessRevision: string) => void;
}

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
const WIKI_LINK_PRESENTATION_REVALIDATION_MS = 30_000;

type PageProviderCacheEntry = {
  identityLifecycle: IdentityLifecycle;
  pageId: string;
  provider: HocuspocusProvider;
};

// React Strict Mode may invoke a useMemo factory twice before committing its
// result. Constructing a provider directly in that factory leaks the discarded
// provider and opens two sockets over the same Y.Doc/client ID. Keep the
// provider unique for the document and render identity while React decides
// which memo result to commit. Replaced providers are still destroyed by the
// component's normal lifecycle cleanup below.
const pageProvidersByDocument = new WeakMap<Y.Doc, PageProviderCacheEntry>();

function getOrCreatePageProvider(
  doc: Y.Doc,
  pageId: string,
  identityLifecycle: IdentityLifecycle,
  create: () => HocuspocusProvider,
): HocuspocusProvider {
  const cached = pageProvidersByDocument.get(doc);
  if (
    cached?.pageId === pageId &&
    cached.identityLifecycle === identityLifecycle &&
    cached.provider.isAttached
  ) {
    return cached.provider;
  }

  const provider = create();
  pageProvidersByDocument.set(doc, { identityLifecycle, pageId, provider });
  return provider;
}

type TerminalCollabEviction = 'access_revoked' | 'page_deleted';
type CollabCloseEvent = onCloseParameters['event'];

function getTerminalCollabEviction({
  code,
  reason,
}: CollabCloseEvent): TerminalCollabEviction | null {
  // Hocuspocus turns its per-document CLOSE message into code 1000 and
  // preserves only the server reason. Native WebSocket closes retain 44xx.
  if (
    code === 4401 ||
    reason === COLLAB_TERMINAL_REASONS.ACCESS_REVOKED ||
    reason === COLLAB_TERMINAL_REASONS.SESSION_EXPIRED
  ) {
    return 'access_revoked';
  }
  if (code === 4402 || reason === COLLAB_TERMINAL_REASONS.PAGE_DELETED) return 'page_deleted';
  return null;
}

function _execEditorAction(editor: Editor | null, fn: (ctx: unknown) => void): void {
  if (!editor) return;
  try {
    editor.action(fn);
  } catch {
    /* Editor may have been destroyed */
  }
}

export function MilkdownEditor({
  pageId,
  initialValue,
  onChange,
  onStatusChange,
  onProviderReady,
  onWikiLinkClick,
  onPermissionSnapshot,
}: MilkdownEditorProps) {
  const doc = useMemo(() => new Y.Doc(), []);
  const editorRef = useRef<Editor | null>(null);
  const { isAnonymous } = useShareContext();
  const { data: session } = useAuth();
  const currentUserId = session?.user?.id ?? null;
  const isReadOnly = useIsReadOnly();
  const setReadOnly = useSetReadOnly();
  const setAccessPermission = useSetAccessPermission();
  const setCapabilities = useSetCapabilities();
  const navigate = useIdentityNavigate();
  const identityLifecycle = useIdentityLifecycle();
  const queryClient = useQueryClient();
  const latestAccessRevisionRef = useRef<{ pageId: string; revision: bigint | null }>({
    pageId,
    revision: null,
  });
  const authoritativePermissionRef = useRef<SharePermission | null | undefined>(undefined);
  const latestOnPermissionSnapshot = useRef(onPermissionSnapshot);
  latestOnPermissionSnapshot.current = onPermissionSnapshot;

  const {
    suggestions,
    allPages,
    handleWikiLinkSuggest,
    handleWikiLinkSelect,
    handleAddPage,
    canAddPage,
    closeSuggestions,
  } = useWikiLinkSuggestions(editorRef, pageId);

  const [activeStates, setActiveStates] = useState({
    isBoldActive: false,
    isItalicActive: false,
    isStrikeActive: false,
    isCodeActive: false,
    isLinkActive: false,
    isBlockquoteActive: false,
    isH1Active: false,
    isH2Active: false,
    isH3Active: false,
    isH4Active: false,
    isH5Active: false,
    isH6Active: false,
    isBulletListActive: false,
    isOrderedListActive: false,
    isTaskListActive: false,
    isInTableActive: false,
  });

  const hasMark = useCallback((state: EditorState, markType?: MarkType): boolean => {
    if (!markType) return false;
    const { selection, storedMarks, doc } = state;
    if (selection.empty) {
      return !!markType.isInSet(storedMarks ?? selection.$head.marks());
    }
    return doc.rangeHasMark(selection.from, selection.to, markType);
  }, []);

  const hasBlockType = useCallback(
    (state: EditorState, nodeType?: NodeType, attrs?: Record<string, unknown>): boolean => {
      if (!nodeType) return false;
      const { $from } = state.selection;

      const depth = $from.depth;
      for (let d = depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === nodeType) {
          if (!attrs) return true;
          for (const [key, value] of Object.entries(attrs)) {
            const nodeValue = node.attrs[key];
            if (String(nodeValue) !== String(value)) {
              return false;
            }
          }
          return true;
        }
      }
      return false;
    },
    [],
  );

  const hasParentBlockType = useCallback((state: EditorState, nodeType?: NodeType): boolean => {
    if (!nodeType) return false;
    const { $from } = state.selection;
    const depth = $from.depth;
    for (let d = depth; d > 0; d--) {
      if ($from.node(d).type === nodeType) {
        return true;
      }
    }
    // Handle AllSelection / depth-0: check doc's direct children
    if (depth === 0) {
      for (let i = 0; i < state.doc.content.childCount; i++) {
        if (state.doc.content.child(i).type === nodeType) {
          return true;
        }
      }
    }
    return false;
  }, []);

  const updateActiveStates = useCallback(() => {
    const editorInstance = editorRef.current as unknown as {
      action: (cb: (ctx: unknown) => void) => void;
    } | null;
    if (!editorInstance) return;
    try {
      editorInstance.action((ctx) => {
        const view = (ctx as unknown as { get: (key: unknown) => unknown }).get(editorViewCtx);
        if (!view) return;
        const { state } = view as { state: EditorState };
        const schema = state.schema as unknown as {
          marks: Record<string, MarkType>;
          nodes: Record<string, NodeType>;
        };
        const marks = schema.marks;
        const nodes = schema.nodes;

        const closestListDisplayType = getClosestListType(state);

        setActiveStates({
          isBoldActive: hasMark(state, marks.strong),
          isItalicActive: hasMark(state, marks.emphasis),
          isStrikeActive: hasMark(state, marks.strike_through),
          isCodeActive: hasMark(state, marks.inlineCode) || hasBlockType(state, nodes.code_block),
          isLinkActive: hasMark(state, marks.link),
          isBlockquoteActive: hasParentBlockType(state, nodes.blockquote),
          isH1Active: hasBlockType(state, nodes.heading, { level: 1 }),
          isH2Active: hasBlockType(state, nodes.heading, { level: 2 }),
          isH3Active: hasBlockType(state, nodes.heading, { level: 3 }),
          isH4Active: hasBlockType(state, nodes.heading, { level: 4 }),
          isH5Active: hasBlockType(state, nodes.heading, { level: 5 }),
          isH6Active: hasBlockType(state, nodes.heading, { level: 6 }),
          isBulletListActive: closestListDisplayType === 'bullet',
          isOrderedListActive: closestListDisplayType === 'ordered',
          isTaskListActive: closestListDisplayType === 'task',
          isInTableActive: isInTable(state),
        });
      });
    } catch {
      // Editor may have been destroyed
    }
  }, [hasMark, hasBlockType, hasParentBlockType]);

  // Cache the collab session token so HocuspocusProvider reconnection
  // doesn't fire a redundant get-session API call on every retry.
  // Key the cache by user ID to avoid session fixation on shared machines.
  const cachedTokenRef = useRef<{ token: string; userId: string; expiresAt: number } | null>(null);
  const isAnonymousRef = useRef(isAnonymous);
  const currentUserIdRef = useRef(currentUserId);
  const tokenIdentity = isAnonymous ? 'anonymous' : currentUserId;
  const previousTokenIdentityRef = useRef(tokenIdentity);
  isAnonymousRef.current = isAnonymous;
  currentUserIdRef.current = currentUserId;
  const statelessHandlerRef = useRef<(({ payload }: { payload: string }) => void) | null>(null);
  const pendingStatelessPayloadsRef = useRef<string[]>([]);
  const closeHandlerRef = useRef<((parameters: onCloseParameters) => void) | null>(null);
  const pendingCloseEventsRef = useRef<CollabCloseEvent[]>([]);
  const authenticationFailedHandlerRef = useRef<
    ((parameters: onAuthenticationFailedParameters) => void) | null
  >(null);
  const pendingAuthenticationFailuresRef = useRef<onAuthenticationFailedParameters[]>([]);

  const provider = useMemo(() => {
    return getOrCreatePageProvider(doc, pageId, identityLifecycle, () => {
      return new HocuspocusProvider({
        url: COLLAB_URL,
        name: pageId,
        document: doc,
        forceSyncInterval: 2000,
        onStateless: (message) => {
          if (!identityLifecycle.isActive()) return;
          const handler = statelessHandlerRef.current;
          if (handler) handler(message);
          else pendingStatelessPayloadsRef.current.push(message.payload);
        },
        onClose: (parameters) => {
          if (!identityLifecycle.isActive()) return;
          const handler = closeHandlerRef.current;
          if (handler) handler(parameters);
          else pendingCloseEventsRef.current.push(parameters.event);
        },
        onAuthenticationFailed: (parameters) => {
          if (!identityLifecycle.isActive()) return;
          const handler = authenticationFailedHandlerRef.current;
          if (handler) handler(parameters);
          else pendingAuthenticationFailuresRef.current.push(parameters);
        },
        token: async () => {
          if (!identityLifecycle.isActive()) {
            throw new Error('Collaboration identity is no longer active');
          }
          if (isAnonymousRef.current) {
            return `anon:${getAnonymousId()}`;
          }

          const expectedUserId = currentUserIdRef.current;
          const cached = cachedTokenRef.current;
          if (
            expectedUserId &&
            cached?.userId === expectedUserId &&
            Date.now() < cached.expiresAt
          ) {
            return cached.token;
          }

          const session = await authClient.getSession();
          if (!identityLifecycle.isActive()) {
            throw new Error('Collaboration identity is no longer active');
          }
          const token = session.data?.session?.token ?? '';
          const userId = session.data?.user?.id ?? '';
          if (!token || !userId || !expectedUserId || userId !== expectedUserId) {
            cachedTokenRef.current = null;
            throw new Error('Authenticated collaboration session changed or is unavailable');
          }
          cachedTokenRef.current = { token, userId, expiresAt: Date.now() + 5 * 60 * 1000 };
          return token;
        },
      });
    });
  }, [pageId, doc, identityLifecycle]);

  useLayoutEffect(() => {
    if (previousTokenIdentityRef.current !== tokenIdentity) {
      previousTokenIdentityRef.current = tokenIdentity;
      cachedTokenRef.current = null;
    }
  }, [tokenIdentity]);

  // The page API is useful for rendering metadata, but it is not authoritative
  // for a collaboration connection. Keep the editor fail-closed until this
  // provider receives its versioned permission snapshot.
  useLayoutEffect(() => {
    latestAccessRevisionRef.current = { pageId, revision: null };
    authoritativePermissionRef.current = undefined;
    setReadOnly(true);
    setCapabilities(deriveCapabilities(null));
  }, [pageId, setCapabilities, setReadOnly]);

  const handleSlashMenuSuggestRef = useRef<
    (
      isOpen: boolean,
      query: string,
      position: { x: number; y: number; top?: number; bottom?: number } | null,
      range: { from: number; to: number } | null,
    ) => void
  >(() => {});

  const { setContainer, editor } = useMilkdown({
    ...(initialValue !== undefined && { initialValue }),
    ...(onChange !== undefined && { onChange }),
    doc,
    provider,
    onWikiLinkClick,
    onWikiLinkSuggest: handleWikiLinkSuggest,
    onSlashMenuSuggest: useCallback((isOpen, query, position, range) => {
      handleSlashMenuSuggestRef.current(isOpen, query, position, range);
    }, []),
    readOnly: isReadOnly,
  });

  useEffect(() => {
    if (!editor) return undefined;
    let unregister: (() => void) | undefined;
    const refreshPresentations = () => {
      try {
        editor.action((ctx) => {
          refreshWikiLinkPresentations(ctx.get(editorViewCtx));
        });
        queryClient.invalidateQueries({ queryKey: ['backlinks'] });
      } catch {
        // The editor may be retiring while the timer fires.
      }
    };
    try {
      editor.action((ctx) => {
        unregister = registerWikiLinkPresentationResolver(ctx.get(editorViewCtx), (requests) =>
          fetchWikiLinkPresentations(pageId, requests),
        );
      });
    } catch {
      return undefined;
    }
    const interval = window.setInterval(
      refreshPresentations,
      WIKI_LINK_PRESENTATION_REVALIDATION_MS,
    );
    return () => {
      window.clearInterval(interval);
      unregister?.();
    };
  }, [editor, pageId, queryClient]);

  useAwareness(provider);

  // Cleanup: destroy provider and Y.Doc on unmount. The ref-capture
  // pattern distinguishes Strict Mode double-fire from real unmount:
  // when latest refs differ from captured, we know the instances were
  // replaced (Strict Mode re-render) and we destroy the old ones
  // immediately. When refs match, we wait for isMountedRef to flip
  // false (real unmount) via setTimeout.
  // The status listener effect below is declared AFTER this one, so
  // React cleans it up FIRST (bottom-to-top), removing the listener
  // before provider.destroy() fires its disconnected event.
  const isMountedRef = useRef(true);
  const latestProviderRef = useRef(provider);
  const latestDocRef = useRef(doc);
  latestProviderRef.current = provider;
  latestDocRef.current = doc;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const capturedProvider = provider;
    const capturedDoc = doc;

    return () => {
      if (latestProviderRef.current !== capturedProvider || latestDocRef.current !== capturedDoc) {
        capturedProvider.forceSync();
        capturedProvider.destroy();
        capturedDoc.destroy();
        return;
      }
      setTimeout(() => {
        if (!isMountedRef.current) {
          capturedProvider.forceSync();
          capturedProvider.destroy();
          capturedDoc.destroy();
        }
      }, 0);
    };
  }, [provider, doc]);

  const { visible, position, keepVisible, reposition } = useFloatingToolbar();

  const runMarkCommand = (markName: string, attrs?: Record<string, unknown>) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const marks = (state.schema as unknown as { marks: Record<string, unknown> }).marks;
      const markType = marks[markName];
      if (!markType) return;

      const command = toggleMark(markType as never, attrs);
      command(state, dispatch);
    });
  };

  const runBlockCommand = (nodeName: string, attrs?: Record<string, unknown>) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const nodes = (state.schema as unknown as { nodes: Record<string, unknown> }).nodes;
      const nodeType = nodes[nodeName];
      const paraType = nodes.paragraph;
      if (!nodeType || !paraType) return;

      const { $from } = state.selection;

      let currentLevel: number | null = null;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === nodeType && 'level' in node.attrs) {
          currentLevel = node.attrs.level;
          break;
        }
      }

      const targetLevel = attrs?.level as number | undefined;
      if (Number(currentLevel) === Number(targetLevel)) {
        const command = setBlockType(paraType as never);
        command(state, dispatch);
      } else {
        const command = setBlockType(nodeType as never, attrs);
        command(state, dispatch);
      }
      setTimeout(reposition, 0);
    });
  };

  const runCodeCommand = () => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const schema = state.schema as unknown as { nodes: Record<string, NodeType> };
      const nodes = schema.nodes;
      const marks = (state.schema as unknown as { marks: Record<string, MarkType> }).marks;
      const codeBlockType = nodes.code_block;
      const paragraphType = nodes.paragraph;
      const inlineCodeMark = marks.inlineCode;

      if (!codeBlockType || !paragraphType) {
        if (!inlineCodeMark) return;
        const command = toggleMark(inlineCodeMark as never);
        command(state, dispatch);
        return;
      }

      const isCodeBlockActive = hasBlockType(state, codeBlockType);

      if (isCodeBlockActive) {
        const $from = state.selection.$from;
        const blockStart = $from.before($from.depth);
        const blockEnd = $from.after($from.depth);
        const codeBlock = state.doc.nodeAt(blockStart);

        if (codeBlock && codeBlock.type === codeBlockType) {
          const content = codeBlock.textContent;
          const lines = content
            .split('\n')
            .filter((line, i, arr) => line.length > 0 || i < arr.length - 1);
          const paragraphNodes = lines.map((line) =>
            (paragraphType as NodeType).create(null, state.schema.text(line)),
          );
          const tr = state.tr.replaceWith(blockStart, blockEnd, paragraphNodes);
          dispatch(tr);
        }
        return;
      }

      const { from, to } = state.selection;
      const selectedText = state.doc.textBetween(from, to, '\n', '\n');
      const isMultiline =
        from !== to &&
        (selectedText.includes('\n') ||
          state.selection.$from.start() !== state.selection.$to.start());

      if (isMultiline) {
        const textNode = state.schema.text(selectedText);
        const codeBlock = (codeBlockType as NodeType).create({ language: '' }, textNode);
        const tr = state.tr.replaceSelectionWith(codeBlock);
        dispatch(tr);
        return;
      }

      if (!inlineCodeMark) return;
      const command = toggleMark(inlineCodeMark as never);
      command(state, dispatch);
    });
  };

  const handleBold = () => {
    runMarkCommand('strong');
    setTimeout(updateActiveStates, 0);
  };
  const handleItalic = () => {
    runMarkCommand('emphasis');
    setTimeout(updateActiveStates, 0);
  };
  const handleStrike = () => {
    runMarkCommand('strike_through');
    setTimeout(updateActiveStates, 0);
  };
  const handleCode = () => {
    runCodeCommand();
    setTimeout(updateActiveStates, 0);
  };
  const handleLink = () => {
    const url = prompt('Enter link URL:');
    if (!url || !editor) return;

    const safeUrl = ensureAbsoluteUrl(url);
    if (!safeUrl) {
      showInfoToast('Enter a safe HTTP, HTTPS, email, phone, or relative link');
      return;
    }

    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;

      const { state, dispatch } = view;
      const linkMark = state.schema.marks.link;
      if (!linkMark) return;

      const mark = linkMark.create({ href: safeUrl });
      const tr = state.tr.addMark(state.selection.from, state.selection.to, mark);
      dispatch(tr);
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleBlockquote = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const blockquoteType = state.schema.nodes.blockquote;
      if (!blockquoteType) return;

      const inBlockquote = hasParentBlockType(state, blockquoteType);

      if (inBlockquote) {
        const command = lift;
        command(state, dispatch);
      } else {
        const command = wrapIn(blockquoteType as never);
        command(state, dispatch);
      }
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleImageUpload = async (file: File) => {
    if (!identityLifecycle.isActive()) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('pageId', pageId);
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!identityLifecycle.isActive()) return;
      if (!res.ok) {
        const err = await res.json();
        if (!identityLifecycle.isActive()) return;
        throw new Error(err.message ?? 'Upload failed');
      }
      const data = await res.json();
      if (!identityLifecycle.isActive()) return;
      const imageMarkdown = `![${file.name}](${data.url})`;
      if (editor) {
        keepVisible();
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!view) return;
          const { state, dispatch } = view;
          const imageNode = state.schema.nodes.image;
          if (!imageNode) {
            const text = state.selection.from;
            const tr = state.tr.insert(text, state.schema.text(imageMarkdown));
            dispatch(tr);
            return;
          }
          const node = imageNode.create({ src: data.url, alt: file.name });
          const tr = state.tr.insert(state.selection.from, node);
          dispatch(tr);
        });
      }
    } catch (e) {
      if (!identityLifecycle.isActive()) return;
      alert(`Upload failed: ${(e as Error).message}`);
    }
  };

  const handleImageUploadFromSlash = () => {
    if (!identityLifecycle.isActive()) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      if (!identityLifecycle.isActive()) return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        handleImageUpload(file);
      }
    };
    input.click();
  };

  const { slashMenuState, handleSlashMenuSuggest, closeSlashMenu, slashCommands } = useSlashMenu(
    editorRef,
    {
      handleBold,
      handleItalic,
      handleStrike,
      handleCode,
      handleLink,
      handleImageUploadFromSlash,
    },
  );

  handleSlashMenuSuggestRef.current = handleSlashMenuSuggest;

  const handleH1 = () => {
    runBlockCommand('heading', { level: 1 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH2 = () => {
    runBlockCommand('heading', { level: 2 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH3 = () => {
    runBlockCommand('heading', { level: 3 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH4 = () => {
    runBlockCommand('heading', { level: 4 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH5 = () => {
    runBlockCommand('heading', { level: 5 });
    setTimeout(updateActiveStates, 0);
  };
  const handleH6 = () => {
    runBlockCommand('heading', { level: 6 });
    setTimeout(updateActiveStates, 0);
  };
  const handleBulletList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      if (!bulletListType || !dispatch) return;

      // Base decisions on the closest (innermost) list, not any ancestor.
      // This ensures ordered lists nested inside bullets convert correctly
      // instead of accidentally unwrapping the inner list.
      const closestType = getClosestListType(state);
      if (closestType === 'task') {
        switchListType(state, bulletListType, dispatch, {});
      } else if (closestType === 'bullet') {
        unwrapList(state, dispatch);
      } else if (closestType === 'ordered') {
        switchListType(state, bulletListType, dispatch);
      } else {
        wrapBlocksInList(state, bulletListType, dispatch);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
  };
  const handleOrderedList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const orderedListType = state.schema.nodes.ordered_list;
      if (!orderedListType || !dispatch) return;

      const closestType = getClosestListType(state);
      if (closestType === 'ordered') {
        // Check if the selection also contains top-level blocks outside
        // any list. If so, rebuild all content into one list.
        const { from, to } = state.selection;
        const listItemType = state.schema.nodes.list_item;
        let hasNonList = false;
        if (from !== to) {
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isBlock || node.type.name === 'doc') return;
            const $pos = state.doc.resolve(pos);
            if ($pos.depth <= 1 && node.type !== listItemType && node.type !== orderedListType) {
              hasNonList = true;
            }
          });
        }
        if (!hasNonList) {
          unwrapList(state, dispatch);
        } else {
          wrapBlocksInList(state, orderedListType, dispatch);
        }
      } else if (closestType === 'task') {
        switchListType(state, orderedListType, dispatch, {});
      } else if (closestType === 'bullet') {
        switchListType(state, orderedListType, dispatch);
      } else {
        wrapBlocksInList(state, orderedListType, dispatch);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
  };
  const handleTaskList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const bulletListType = state.schema.nodes.bullet_list;
      const listItemType = state.schema.nodes.list_item;
      if (!bulletListType || !listItemType || !dispatch) return;

      const taskAttrs = { checked: false };
      const closestType = getClosestListType(state);
      if (closestType === 'task') {
        unwrapList(state, dispatch);
      } else if (closestType === 'bullet' || closestType === 'ordered') {
        switchListType(state, bulletListType, dispatch, taskAttrs);
      } else {
        wrapBlocksInList(state, bulletListType, dispatch, taskAttrs);
      }
    });
    setTimeout(() => {
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx);
        if (v && !v.hasFocus()) v.focus();
      });
    }, 0);
    setTimeout(updateActiveStates, 0);
    setTimeout(reposition, 0);
  };
  const handleInsertTable = () => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(insertTableCommand.key, { row: 3, col: 3 });
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleTableAction = (
    action:
      | 'addRowBefore'
      | 'addRowAfter'
      | 'addColBefore'
      | 'addColAfter'
      | 'deleteRow'
      | 'deleteCol'
      | 'deleteTable',
  ) => {
    if (!editor) return;
    keepVisible();

    editor.action((ctx) => {
      const viewInstance = ctx.get(editorViewCtx) as EditorView | undefined;
      if (!viewInstance) return;

      const { state, dispatch } = viewInstance;

      if (!isInTable(state)) return;

      switch (action) {
        case 'addRowBefore':
          addRowBefore(state, dispatch);
          break;
        case 'addRowAfter':
          addRowAfter(state, dispatch);
          break;
        case 'addColBefore':
          addColumnBefore(state, dispatch);
          break;
        case 'addColAfter':
          addColumnAfter(state, dispatch);
          break;
        case 'deleteRow':
          deleteRow(state, dispatch);
          break;
        case 'deleteCol':
          deleteColumn(state, dispatch);
          break;
        case 'deleteTable':
          deleteTable(state, dispatch);
          break;
      }
    });
    setTimeout(updateActiveStates, 0);
  };

  const handleAddRowBefore = () => handleTableAction('addRowBefore');
  const handleAddRowAfter = () => handleTableAction('addRowAfter');
  const handleAddColBefore = () => handleTableAction('addColBefore');
  const handleAddColAfter = () => handleTableAction('addColAfter');
  const handleDeleteRow = () => handleTableAction('deleteRow');
  const handleDeleteCol = () => handleTableAction('deleteCol');
  const handleDeleteTable = () => handleTableAction('deleteTable');

  // ─── Keyboard shortcut registrations for slash menu commands ───

  // Utility: returns true only when the Milkdown/ProseMirror editor has DOM focus.
  // Editor-scoped shortcuts use this to avoid capturing shortcuts meant
  // for the command palette, page title, or other inputs.
  function editorHasFocus(): boolean {
    if (!editor) return false;
    let focused = false;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view) focused = view.hasFocus();
      });
    } catch {
      /* Editor may have been destroyed */
    }
    return focused;
  }

  // Helper: wraps an editor action so it only fires when the editor is focused,
  // and returns false to allow the next binding to handle the event otherwise.
  const ed = (action: () => void) => (): boolean => {
    if (isReadOnly || !editorHasFocus()) return false;
    action();
    return true;
  };

  // Mapping from normalized shortcut → handler for every slash-command shortcut.
  // The slash menu displays these same shortcuts — these registrations make
  // them functional as real keyboard bindings.
  useShortcut({
    key: 'mod+alt+0',
    handler: ed(() => runBlockCommand('paragraph')),
    scope: 'editor',
    description: 'Paragraph',
  });
  useShortcut({
    key: 'mod+alt+1',
    handler: ed(handleH1),
    scope: 'editor',
    description: 'Heading 1',
  });
  useShortcut({
    key: 'mod+alt+2',
    handler: ed(handleH2),
    scope: 'editor',
    description: 'Heading 2',
  });
  useShortcut({
    key: 'mod+alt+3',
    handler: ed(handleH3),
    scope: 'editor',
    description: 'Heading 3',
  });
  useShortcut({
    key: 'mod+alt+4',
    handler: ed(handleH4),
    scope: 'editor',
    description: 'Heading 4',
  });
  useShortcut({
    key: 'mod+alt+5',
    handler: ed(handleH5),
    scope: 'editor',
    description: 'Heading 5',
  });
  useShortcut({
    key: 'mod+alt+6',
    handler: ed(handleH6),
    scope: 'editor',
    description: 'Heading 6',
  });
  useShortcut({ key: 'mod+b', handler: ed(handleBold), scope: 'editor', description: 'Bold' });
  useShortcut({ key: 'mod+i', handler: ed(handleItalic), scope: 'editor', description: 'Italic' });
  useShortcut({
    key: 'mod+shift+x',
    handler: ed(handleStrike),
    scope: 'editor',
    description: 'Strikethrough',
  });
  useShortcut({ key: 'mod+`', handler: ed(handleCode), scope: 'editor', description: 'Code' });
  useShortcut({
    key: 'mod+shift+>',
    handler: ed(handleBlockquote),
    scope: 'editor',
    description: 'Blockquote',
  });
  // Ctrl+K: only opens the link dialog when text is selected in the editor.
  // When the editor is unfocused or no text is selected, returns false so
  // the command palette's mod+k can fire.
  useShortcut({
    key: 'mod+k',
    handler: (): boolean => {
      if (!editor) return false;
      let canLink = false;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view?.hasFocus()) return;
        const { from, to } = view.state.selection;
        canLink = from !== to;
      });
      if (!canLink) return false;
      handleLink();
      return true;
    },
    scope: 'editor',
    priority: 'high',
    description: 'Insert link',
  });
  // Ctrl+Shift+number: different browsers behave differently — most suppress
  // Shift's character mapping when Ctrl is held (event.key stays '8'), but
  // Zen and some others produce the shifted character ('*'). Register both
  // forms so it works everywhere.
  useShortcut({
    key: 'mod+shift+8',
    handler: ed(handleBulletList),
    scope: 'editor',
    description: 'Bullet list',
  });
  useShortcut({
    key: 'mod+shift+*',
    handler: ed(handleBulletList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+7',
    handler: ed(handleOrderedList),
    scope: 'editor',
    description: 'Ordered list',
  });
  useShortcut({
    key: 'mod+shift+&',
    handler: ed(handleOrderedList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+[',
    handler: ed(handleTaskList),
    scope: 'editor',
    description: 'Task list',
  });
  useShortcut({
    key: 'mod+shift+{',
    handler: ed(handleTaskList),
    scope: 'editor',
    description: '',
  });
  useShortcut({
    key: 'mod+shift+i',
    handler: ed(handleImageUploadFromSlash),
    scope: 'editor',
    description: 'Insert image',
  });
  useShortcut({
    key: 'mod+shift+#',
    handler: ed(() => {
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view) return;
        const { $from } = view.state.selection;
        const tr = view.state.tr.insertText('#tag ', $from.pos);
        view.dispatch(tr);
      });
    }),
    scope: 'editor',
    description: 'Insert tag',
  });

  useEffect(() => {
    onProviderReady?.(provider);
  }, [provider, onProviderReady]);

  const latestOnStatusChange = useRef(onStatusChange);
  latestOnStatusChange.current = onStatusChange;
  const logger = getLogger();

  // biome-ignore lint/correctness/useExhaustiveDependencies: logger is stable, doc.on/off are event subscriptions
  useEffect(() => {
    let hasEvictedPage = false;

    const evictPage = (
      reason: TerminalCollabEviction,
      suppressToast: boolean,
      deletedEntityType: 'page' | 'folder' = 'page',
    ) => {
      if (hasEvictedPage || !identityLifecycle.isActive()) return;
      hasEvictedPage = true;
      authoritativePermissionRef.current = null;
      setReadOnly(true);
      setAccessPermission(null);
      setCapabilities(deriveCapabilities(null));
      const detailParentId = queryClient.getQueryData<Page>(['pages', 'detail', pageId])?.parentId;
      const treeParentId = queryClient
        .getQueryData<PageTreeNode[]>(['pageTree'])
        ?.find((page) => page.id === pageId)?.parentId;
      const parentId = detailParentId ?? treeParentId;
      queryClient.removeQueries({ queryKey: ['pages', 'detail', pageId], exact: true });
      invalidateWorkspaceAccessQueries(queryClient);
      if (!suppressToast) {
        showInfoToast(
          reason === 'access_revoked'
            ? 'Removed from your view'
            : deletedEntityType === 'folder'
              ? 'Folder deleted'
              : 'Page deleted',
        );
      }
      navigate(suppressToast && parentId ? buildFolderPath('folder', parentId) : '/app', {
        replace: true,
      });
    };

    const handleStatus = ({ status }: { status: WebSocketStatus }) => {
      logger.debug`[collab] status: ${status}`;
      if (status !== WebSocketStatus.Connected) {
        setReadOnly(true);
        setCapabilities(deriveCapabilities(null));
      } else {
        try {
          editorRef.current?.action((ctx) => {
            refreshWikiLinkPresentations(ctx.get(editorViewCtx));
          });
        } catch {
          // The editor may have been destroyed while reconnecting.
        }
      }
      const cb = latestOnStatusChange.current;
      if (cb) {
        cb(status);
      }
    };

    const handleClose = ({ event }: onCloseParameters) => {
      if (!identityLifecycle.isActive()) return;
      const terminalEviction = getTerminalCollabEviction(event);
      logger.debug`[collab] closed: code=${event.code} reason=${event.reason}`;
      // A Hocuspocus CLOSE frame ends this logical document even when the
      // underlying socket remains connected. Never leave that document
      // editable; only exact authorization/deletion signals also evict it.
      setReadOnly(true);
      setCapabilities(deriveCapabilities(null));
      if (terminalEviction === null) return;
      evictPage(terminalEviction, consumeSelfLeave(pageId));
    };

    const handleAuthenticationFailed = ({ reason }: onAuthenticationFailedParameters) => {
      if (!identityLifecycle.isActive()) return;
      logger.debug`[collab] authentication failed: reason=${reason}`;
      // Authentication rejection is authoritative for this document. The
      // page may already be rendered from an API/cache snapshot, so retaining
      // it would expose stale private content after the server denied access.
      evictPage('access_revoked', consumeSelfLeave(pageId));
    };

    const handleSync = ({ documentName, state }: { documentName: string; state: Uint8Array }) => {
      logger.debug`[collab] synced to server: ${documentName}, ${state.length} bytes`;
    };

    const handlePersisted = ({ documentName }: { documentName: string }) => {
      logger.debug`[collab] persisted to db: ${documentName}`;
    };

    const handleAwareness = (args: unknown) => {
      logger.debug`[collab] awareness: ${JSON.stringify(args).slice(0, 100)}`;
    };

    const handleError = (args: unknown) => {
      logger.error`[collab] error: ${args}`;
    };

    const handleStateless = ({ payload }: { payload: string }) => {
      if (!identityLifecycle.isActive()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (error) {
        logger.warn`[collab] ignored malformed stateless message: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn`[collab] ignored malformed stateless message: expected an object`;
        return;
      }
      const message = parsed as Record<string, unknown>;

      const syncPagePermission = (permission: SharePermission | null) => {
        const capabilities = deriveCapabilities(permission);
        queryClient.setQueryData(['pages', 'detail', pageId], (old: unknown) => {
          if (!old || typeof old !== 'object') return old;
          return {
            ...(old as Record<string, unknown>),
            userPermission: permission,
            accessPermission: permission === 'admin' ? 'edit' : permission,
            capabilities,
          };
        });
      };

      if (message.type === 'permission_snapshot') {
        const permission = message.permission;
        const accessRevision = message.accessRevision;
        const validPermission =
          permission === null ||
          permission === 'view' ||
          permission === 'edit' ||
          permission === 'admin';
        if (
          !validPermission ||
          typeof accessRevision !== 'string' ||
          !/^\d+$/.test(accessRevision)
        ) {
          logger.warn`[collab] ignored malformed permission snapshot`;
          return;
        }

        let revision: bigint;
        try {
          revision = BigInt(accessRevision);
        } catch {
          logger.warn`[collab] ignored malformed permission revision`;
          return;
        }
        const previousRevision =
          latestAccessRevisionRef.current.pageId === pageId
            ? latestAccessRevisionRef.current.revision
            : null;
        const previousPermission = authoritativePermissionRef.current;
        if (
          !shouldApplyPermissionSnapshot(
            previousRevision !== null && previousPermission !== undefined
              ? {
                  permission: previousPermission,
                  accessRevision: previousRevision.toString(),
                }
              : null,
            { permission, accessRevision },
          )
        ) {
          logger.warn`[collab] ignored stale permission snapshot revision=${accessRevision}`;
          return;
        }

        latestAccessRevisionRef.current = { pageId, revision };
        authoritativePermissionRef.current = permission;
        const isPermissionTransition =
          previousRevision === null ||
          revision > previousRevision ||
          previousPermission !== permission;
        const isSelfLeaveTransition = isPermissionTransition && consumeSelfLeave(pageId);
        setReadOnly(permission === null || permission === 'view');
        setAccessPermission(permission === 'admin' ? 'edit' : permission);
        setCapabilities(deriveCapabilities(permission));
        syncPagePermission(permission);
        latestOnPermissionSnapshot.current?.(permission, accessRevision);

        if (permission === null) {
          evictPage('access_revoked', isSelfLeaveTransition);
        } else if (
          previousRevision !== null &&
          (revision > previousRevision || previousPermission !== permission)
        ) {
          invalidateWorkspaceAccessQueries(queryClient);
        }
        if (
          permission !== null &&
          previousPermission !== undefined &&
          previousPermission !== permission
        ) {
          showInfoToast(
            permission === 'view'
              ? 'This page is now view-only'
              : permission === 'admin'
                ? 'You are now an admin'
                : 'You can now edit this page',
          );
        }
        return;
      }

      // Old format (backward compat during rollout): { type: 'permission_changed', permission }
      if (message.type === 'permission_changed') {
        if (authoritativePermissionRef.current !== undefined) return;
        const permission = message.permission as string | undefined;
        const isSelfLeaveTransition = consumeSelfLeave(pageId);
        logger.info`[collab] permission changed: ${permission}`;
        if (permission === 'view') {
          setReadOnly(true);
          setAccessPermission('view');
          setCapabilities(deriveCapabilities('view'));
          syncPagePermission('view');
          showInfoToast('This page is now view-only');
        } else if (permission === 'edit') {
          setReadOnly(false);
          setAccessPermission('edit');
          setCapabilities(deriveCapabilities('edit'));
          syncPagePermission('edit');
          showInfoToast('You can now edit this page');
        } else if (permission === 'private') {
          evictPage('access_revoked', isSelfLeaveTransition);
        }
        return;
      }

      if (message.type === 'share_event') {
        const action = message.action as string | undefined;
        const permission = message.permission as string | undefined;
        logger.info`[collab] share event: action=${action} permission=${permission}`;
        // This is a notification hint only. A versioned permission_snapshot
        // is the sole authority for editor mode and access loss so a direct
        // revoke cannot erase a valid folder/workspace/public-access fallback.
        queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
        queryClient.invalidateQueries({ queryKey: ['pageTree'] });
        queryClient.invalidateQueries({ queryKey: ['folderTree'] });
        queryClient.invalidateQueries({ queryKey: ['shares'] });
        return;
      }

      if (message.type === 'entity_deleted') {
        const entityType = message.entityType as string | undefined;
        const entityId = message.entityId as string | undefined;
        logger.info`[collab] entity deleted: entityType=${entityType} entityId=${entityId}`;
        evictPage(
          'page_deleted',
          consumeSelfLeave(pageId),
          entityType === 'folder' ? 'folder' : 'page',
        );
        return;
      }

      if (message.type === 'wiki_link_presentations_changed') {
        const rawTargetIds = message.targetIds;
        const targetIds = Array.isArray(rawTargetIds)
          ? rawTargetIds.filter((targetId): targetId is string => typeof targetId === 'string')
          : undefined;
        try {
          editorRef.current?.action((ctx) => {
            refreshWikiLinkPresentations(ctx.get(editorViewCtx), targetIds);
          });
        } catch {
          // The editor may have been destroyed while the event was in flight.
        }
        queryClient.invalidateQueries({ queryKey: ['backlinks'] });
        return;
      }

      if (message.type === 'grant_received') {
        const sharedByName = message.sharedByName as string | undefined;
        const entityTitle = message.entityTitle as string | undefined;
        const toastMessage = (message as { message?: string }).message;
        logger.info`[collab] grant received: ${sharedByName} shared ${entityTitle}`;
        queryClient.invalidateQueries({ queryKey: ['shared-with-me'] });
        queryClient.invalidateQueries({ queryKey: ['pageTree'] });
        queryClient.invalidateQueries({ queryKey: ['folderTree'] });
        showInfoToast(
          toastMessage ??
            `${sharedByName ?? 'Someone'} shared ${entityTitle ?? 'something'} with you. Refresh to see it.`,
        );
        return;
      }
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('persisted', handlePersisted);
    provider.on('awareness', handleAwareness);
    provider.on('error', handleError);
    statelessHandlerRef.current = handleStateless;
    closeHandlerRef.current = handleClose;
    authenticationFailedHandlerRef.current = handleAuthenticationFailed;
    for (const payload of pendingStatelessPayloadsRef.current.splice(0)) {
      handleStateless({ payload });
    }
    for (const event of pendingCloseEventsRef.current.splice(0)) {
      handleClose({ event });
    }
    for (const parameters of pendingAuthenticationFailuresRef.current.splice(0)) {
      handleAuthenticationFailed(parameters);
    }

    const onDocUpdate = (_update: Uint8Array, origin: unknown) => {
      logger.debug`[collab] doc update: origin=${String(origin)}, bytes=${_update.length}`;
    };
    doc.on('update', onDocUpdate);

    logger.info`[editor] connecting to collab: ${pageId}`;

    setTimeout(() => {
      if (latestOnStatusChange.current) {
        latestOnStatusChange.current(WebSocketStatus.Connecting);
      }
    }, 0);

    return () => {
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.off('persisted', handlePersisted);
      provider.off('awareness', handleAwareness);
      provider.off('error', handleError);
      if (statelessHandlerRef.current === handleStateless) statelessHandlerRef.current = null;
      if (closeHandlerRef.current === handleClose) closeHandlerRef.current = null;
      if (authenticationFailedHandlerRef.current === handleAuthenticationFailed) {
        authenticationFailedHandlerRef.current = null;
      }
      doc.off('update', onDocUpdate);
      logger.debug`[editor] disconnected: ${pageId}`;
    };
  }, [provider, pageId]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const editorInstanceRef = editor;
    let isMounted = true;

    const handleSelectionChange = () => {
      if (!isMounted) return;
      updateActiveStates();
    };

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      view.dom.addEventListener('keyup', handleSelectionChange);
      view.dom.addEventListener('mouseup', handleSelectionChange);
    });

    return () => {
      isMounted = false;
      try {
        editorInstanceRef.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          if (!view) return;
          view.dom.removeEventListener('keyup', handleSelectionChange);
          view.dom.removeEventListener('mouseup', handleSelectionChange);
        });
      } catch {
        // Editor may have been destroyed during cleanup race condition
      }
    };
  }, [editor, updateActiveStates]);

  return (
    <div
      className={`editor-wrapper min-h-[500px] relative ${isReadOnly ? '' : 'editor-scroll-past-end'}`}
    >
      {!isReadOnly && (
        <>
          <WikiLinkSuggestions
            isOpen={suggestions.isOpen}
            query={suggestions.query}
            pages={allPages}
            position={suggestions.position}
            onSelect={handleWikiLinkSelect}
            onClose={closeSuggestions}
            {...(canAddPage ? { onAddPage: handleAddPage } : {})}
          />
          <SlashMenu
            isOpen={slashMenuState.isOpen}
            query={slashMenuState.query}
            position={slashMenuState.position}
            commands={slashCommands}
            onClose={closeSlashMenu}
          />
          <FloatingToolbar
            visible={visible}
            position={position}
            onBold={handleBold}
            onItalic={handleItalic}
            onStrike={handleStrike}
            onCode={handleCode}
            onLink={handleLink}
            onBlockquote={handleBlockquote}
            onImageUpload={handleImageUpload}
            onH1={handleH1}
            onH2={handleH2}
            onH3={handleH3}
            onH4={handleH4}
            onH5={handleH5}
            onH6={handleH6}
            onBulletList={handleBulletList}
            onOrderedList={handleOrderedList}
            onTaskList={handleTaskList}
            onInsertTable={handleInsertTable}
            onAddRowBefore={handleAddRowBefore}
            onAddRowAfter={handleAddRowAfter}
            onAddColBefore={handleAddColBefore}
            onAddColAfter={handleAddColAfter}
            onDeleteRow={handleDeleteRow}
            onDeleteCol={handleDeleteCol}
            onDeleteTable={handleDeleteTable}
            {...activeStates}
          />
        </>
      )}
      <div ref={setContainer} className="milkdown-editor" />
    </div>
  );
}
