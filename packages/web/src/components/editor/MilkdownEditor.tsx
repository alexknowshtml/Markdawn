import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAwareness } from '../../hooks/useAwareness';
import { useFloatingToolbar } from '../../hooks/useFloatingToolbar';
import { useMilkdown } from '../../hooks/useMilkdown';
import { useWikiLinkSuggestions } from '../../hooks/useWikiLinkSuggestions';
import { authClient } from '../../lib/auth-client';
import { getLogger } from '../../logger-init';
import './editor.css';
import { WebSocketStatus } from '@hocuspocus/provider';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { commandsCtx, editorViewCtx } from '@milkdown/core';
import type { Editor } from '@milkdown/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
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
import { WikiLinkSuggestions } from './WikiLinkSuggestions';

interface MilkdownEditorProps {
  pageId: string;
  workspaceId: string;
  initialValue?: string;
  onChange?: (markdown: string) => void;
  onProviderReady?: (provider: HocuspocusProvider) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
  onWikiLinkClick?: (path: string) => void;
}

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';

function execEditorAction(editor: Editor | null, fn: (ctx: unknown) => void): void {
  if (!editor) return;
  try {
    editor.action(fn);
  } catch {
    /* Editor may have been destroyed */
  }
}

export function MilkdownEditor({
  pageId,
  workspaceId,
  initialValue,
  onChange,
  onStatusChange,
  onProviderReady,
  onWikiLinkClick,
}: MilkdownEditorProps) {
  const doc = useMemo(() => new Y.Doc(), []);
  const editorRef = useRef<Editor | null>(null);

  const {
    suggestions,
    allPages,
    handleWikiLinkSuggest,
    handleWikiLinkSelect,
    handleAddPage,
    closeSuggestions,
  } = useWikiLinkSuggestions(workspaceId, editorRef);

  const [activeStates, setActiveStates] = useState({
    isBoldActive: false,
    isItalicActive: false,
    isStrikeActive: false,
    isCodeActive: false,
    isLinkActive: false,
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

        const listItemNode = nodes.list_item;
        const isInListItem = listItemNode ? hasParentBlockType(state, listItemNode) : false;
        const listItemChecked =
          isInListItem && listItemNode
            ? (() => {
                const { $from } = state.selection;
                for (let d = $from.depth; d > 0; d--) {
                  const node = $from.node(d);
                  if (node.type === listItemNode) {
                    const checked = node.attrs.checked;
                    return checked === true || checked === 'true';
                  }
                }
                return false;
              })()
            : false;

        setActiveStates({
          isBoldActive: hasMark(state, marks.strong),
          isItalicActive: hasMark(state, marks.emphasis),
          isStrikeActive: hasMark(state, marks.strike_through),
          isCodeActive: hasMark(state, marks.inlineCode) || hasBlockType(state, nodes.code_block),
          isLinkActive: hasMark(state, marks.link),
          isH1Active: hasBlockType(state, nodes.heading, { level: 1 }),
          isH2Active: hasBlockType(state, nodes.heading, { level: 2 }),
          isH3Active: hasBlockType(state, nodes.heading, { level: 3 }),
          isH4Active: hasBlockType(state, nodes.heading, { level: 4 }),
          isH5Active: hasBlockType(state, nodes.heading, { level: 5 }),
          isH6Active: hasBlockType(state, nodes.heading, { level: 6 }),
          isBulletListActive: hasParentBlockType(state, nodes.bullet_list) && !listItemChecked,
          isOrderedListActive: hasParentBlockType(state, nodes.ordered_list),
          isTaskListActive: listItemChecked,
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

  const provider = useMemo(() => {
    const instance = new HocuspocusProvider({
      url: COLLAB_URL,
      name: pageId,
      document: doc,
      forceSyncInterval: 2000,
      token: async () => {
        const cached = cachedTokenRef.current;
        const session = await authClient.getSession();
        const token = session.data?.session?.token ?? '';
        const userId = session.data?.user?.id ?? '';
        if (cached && cached.userId === userId && Date.now() < cached.expiresAt) {
          return cached.token;
        }
        cachedTokenRef.current = { token, userId, expiresAt: Date.now() + 5 * 60 * 1000 };
        return token;
      },
    });

    return instance;
  }, [doc, pageId]);

  const { setContainer, editor } = useMilkdown({
    ...(initialValue !== undefined && { initialValue }),
    ...(onChange !== undefined && { onChange }),
    doc,
    provider,
    onWikiLinkClick,
    onWikiLinkSuggest: handleWikiLinkSuggest,
  });

  useAwareness(provider);

  const { visible, position, keepVisible } = useFloatingToolbar();

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
      const pos = $from.pos;

      let currentLevel: number | null = null;
      state.doc.nodesBetween(pos, pos + 1, (node) => {
        if (node.type === nodeType && node.attrs.level) {
          currentLevel = node.attrs.level;
        }
      });

      const targetLevel = attrs?.level as number | undefined;
      if (currentLevel === targetLevel) {
        const command = setBlockType(paraType as never);
        command(state, dispatch);
      } else {
        const command = setBlockType(nodeType as never, attrs);
        command(state, dispatch);
      }
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
    if (url && editor) {
      keepVisible();
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view) return;

        const { state, dispatch } = view;
        const linkMark = state.schema.marks.link;
        if (!linkMark) return;

        const mark = linkMark.create({ href: url });
        const tr = state.tr.addMark(state.selection.from, state.selection.to, mark);
        dispatch(tr);
      });
      setTimeout(updateActiveStates, 0);
    }
  };
  const handleImageUpload = async (file: File) => {
    if (!workspaceId) {
      alert('No workspace selected');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('workspaceId', workspaceId);
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? 'Upload failed');
      }
      const data = await res.json();
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
      alert(`Upload failed: ${(e as Error).message}`);
    }
  };
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
      if (!bulletListType) return;
      const command = wrapIn(bulletListType as never);
      command(state, dispatch);
    });
    setTimeout(updateActiveStates, 0);
  };
  const handleOrderedList = () => {
    if (!editor) return;
    keepVisible();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!view) return;
      const { state, dispatch } = view;
      const orderedListType = state.schema.nodes.ordered_list;
      if (!orderedListType) return;
      const command = wrapIn(orderedListType as never);
      command(state, dispatch);
    });
    setTimeout(updateActiveStates, 0);
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

      const command = wrapIn(bulletListType as never);
      command(state, dispatch);

      const newState = view.state;
      const tr = newState.tr;
      const { from, to } = newState.selection;
      newState.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type === listItemType && node.attrs.checked == null) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
        }
      });
      if (tr.docChanged) {
        dispatch(tr);
      }
    });
    setTimeout(updateActiveStates, 0);
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

  useEffect(() => {
    onProviderReady?.(provider);
  }, [provider, onProviderReady]);

  const latestOnStatusChange = useRef(onStatusChange);
  latestOnStatusChange.current = onStatusChange;
  const logger = getLogger();

  // biome-ignore lint/correctness/useExhaustiveDependencies: logger is stable, doc.on/off are event subscriptions
  useEffect(() => {
    const handleStatus = ({ status }: { status: WebSocketStatus }) => {
      logger.debug`[collab] status: ${status}`;
      const cb = latestOnStatusChange.current;
      if (cb) {
        cb(status);
      }
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

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('persisted', handlePersisted);
    provider.on('awareness', handleAwareness);
    provider.on('error', handleError);

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
      doc.off('update', onDocUpdate);
      logger.debug`[editor] disconnected: ${pageId}`;
    };
  }, [provider, pageId]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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
    <div className="editor-wrapper min-h-[500px] relative">
      <WikiLinkSuggestions
        isOpen={suggestions.isOpen}
        query={suggestions.query}
        pages={allPages}
        position={suggestions.position}
        onSelect={handleWikiLinkSelect}
        onClose={closeSuggestions}
        onAddPage={handleAddPage}
      />
      <FloatingToolbar
        visible={visible}
        position={position}
        onBold={handleBold}
        onItalic={handleItalic}
        onStrike={handleStrike}
        onCode={handleCode}
        onLink={handleLink}
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
      <div ref={setContainer} className="milkdown-editor" />
    </div>
  );
}
