import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark, syncHeadingIdPlugin } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { getMarkdown, insert, replaceAll } from '@milkdown/utils';
import Papa from 'papaparse';
import { goToNextCell, isInTable } from 'prosemirror-tables';
import { useEffect, useRef, useState } from 'react';
import { ensureAbsoluteUrl } from '../utils/url';
import { linkEditor } from '../editor/components/LinkEditor';
import { autolink } from '../editor/plugins/autolink';
import { callout } from '../editor/plugins/callout';
import {
  latexCodeBlockViewPlugin,
  mathBlockInputRule,
  mathEditorTooltipPlugin,
  mathInlineInputRule,
  mathInlineSchema,
  mathInlineViewPlugin,
  remarkMathBlockPlugin,
  remarkMathPlugin,
  toggleLatexCommand,
} from '../editor/plugins/math';
import { tag } from '../editor/plugins/tag';
import { wikiLinkView } from '../editor/plugins/wikiLinkView';
import { wikiLink } from '../editor/plugins/wikilink';
import { repairDocument } from '../editor/utils/documentRepair';
import 'katex/dist/katex.min.css';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { getContrastColor } from '@markdawn/shared';
import type * as Y from 'yjs';
import { getLogger } from '../logger-init';
import { getInitial } from '../utils/avatar';

const cursorBuilder = (user: { name: string; color: string; avatar?: string }) => {
  const cursor = document.createElement('span');
  cursor.classList.add('ProseMirror-yjs-cursor');
  cursor.style.borderColor = user.color;
  cursor.style.backgroundColor = user.color;

  const hitArea = document.createElement('div');
  hitArea.classList.add('ProseMirror-yjs-cursor-hitarea');
  cursor.appendChild(hitArea);

  const pill = document.createElement('div');
  pill.classList.add('ProseMirror-yjs-cursor-pill');
  pill.style.backgroundColor = user.color;
  pill.style.color = getContrastColor(user.color);

  if (user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = user.name;
    img.referrerPolicy = 'no-referrer';
    pill.appendChild(img);
  } else {
    const initials = document.createElement('div');
    initials.classList.add('ProseMirror-yjs-cursor-initials');
    initials.innerText = getInitial(user.name);
    pill.appendChild(initials);
  }

  const name = document.createElement('span');
  name.innerText = user.name;
  pill.appendChild(name);

  cursor.appendChild(pill);
  return cursor;
};

function isLikelyMarkdown(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  const markdownSignals = [
    /^#{1,6}\s/m,
    /^>\s/m,
    /^[-*+]\s/m,
    /^\d+\.\s/m,
    /^-{3,}$/m,
    /^```/m,
    /\*\*[^*]+\*\*/,
    /`[^`]+`/,
    /\[[^\]]+\]\([^)]+\)/,
    /\|.+\|/,
    /~~[^~]+~~/,
    /^- \[( |x)\]\s/m,
    /\$[^$]+\$/,
    /^\$\$[\s\S]*?\$\$$/m,
  ];

  return markdownSignals.some((pattern) => pattern.test(trimmed));
}

export function isLikelyTableData(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lines = trimmed.split('\n');
  if (lines.length < 2) return false;

  const result = Papa.parse(trimmed, {
    delimiter: '',
    preview: 5,
  });

  if (!result.data || result.data.length === 0) return false;

  const data = result.data as unknown[][];
  const colCount = data[0]?.length ?? 0;

  if (colCount < 2) return false;

  const isConsistent = data.every((row) => row.length === colCount);

  return isConsistent;
}

export function convertDelimitedToMarkdown(text: string): string {
  const trimmed = text.trim();

  const result = Papa.parse(trimmed, {
    delimiter: '',
  });

  const data = result.data as unknown[][];
  if (!data || data.length === 0) return '';

  const rows = data.map((row) => row.map((cell) => String(cell ?? '').trim()));

  const maxCols = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    while (r.length < maxCols) {
      r.push('');
    }
    return r;
  });

  const firstRow = padded[0] ?? [];
  const header = `| ${firstRow.join(' | ')} |`;
  const separator = `| ${firstRow.map(() => '---').join(' | ')} |`;
  const body = padded.slice(1).map((r) => `| ${r.join(' | ')} |`);

  return [header, separator, ...body].join('\n');
}

interface UseMilkdownProps {
  initialValue?: string;
  onChange?: (markdown: string) => void;
  doc?: Y.Doc;
  provider?: HocuspocusProvider;
  onWikiLinkClick?: ((path: string) => void) | undefined;
  onWikiLinkSuggest?: (
    isOpen: boolean,
    query: string,
    position: { x: number; y: number; top?: number; bottom?: number } | null,
  ) => void;
  onSlashMenuSuggest?: (
    isOpen: boolean,
    query: string,
    position: { x: number; y: number; top?: number; bottom?: number } | null,
    range: { from: number; to: number } | null,
  ) => void;
}

function isTaskChecked(checked: unknown): boolean {
  return checked === true || checked === 'true';
}

function _isTaskListItem(checked: unknown): boolean {
  return checked !== null && checked !== undefined && checked !== '';
}

function findListItemAncestor(
  view: import('@milkdown/kit/prose/view').EditorView,
  pos: number,
): { node: import('@milkdown/kit/prose/model').Node; pos: number } | null {
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'list_item') {
      return { node, pos: $pos.before(d) };
    }
  }
  return null;
}

function scrollToHeading(headingText: string): void {
  const normalized = headingText.toLowerCase().trim();
  const headingId = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let element = document.getElementById(headingId);
  if (!element) {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const h of headings) {
      if (!(h instanceof HTMLElement)) continue;
      const text = h.textContent?.trim().toLowerCase() ?? '';
      if (text === normalized || text.includes(normalized)) {
        if (!h.id) h.id = headingId;
        element = h;
        break;
      }
    }
  }
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

export function useMilkdown({
  initialValue,
  onChange,
  doc,
  provider,
  onWikiLinkClick,
  onWikiLinkSuggest,
  onSlashMenuSuggest,
}: UseMilkdownProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;
  const onWikiLinkSuggestRef = useRef(onWikiLinkSuggest);
  onWikiLinkSuggestRef.current = onWikiLinkSuggest;
  const onSlashMenuSuggestRef = useRef(onSlashMenuSuggest);
  onSlashMenuSuggestRef.current = onSlashMenuSuggest;
  const hasCollab = Boolean(doc && provider);
  const fallbackInitialValue = hasCollab ? undefined : initialValue;

  useEffect(() => {
    if (!container) return;
    let disposed = false;
    let runtimeEditor: Editor | null = null;

    let floatingCopyBtn: HTMLButtonElement | null = null;
    let currentPre: HTMLElement | null = null;

    const copyIconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    const checkIconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    const getCopyButton = (): HTMLButtonElement => {
      if (!floatingCopyBtn) {
        floatingCopyBtn = document.createElement('button');
        floatingCopyBtn.className = 'code-block-copy-btn';
        floatingCopyBtn.type = 'button';
        floatingCopyBtn.innerHTML = copyIconSvg;
        floatingCopyBtn.setAttribute('aria-label', 'Copy code');
        Object.assign(floatingCopyBtn.style, {
          position: 'absolute',
          zIndex: '1000',
          opacity: '0',
          pointerEvents: 'none',
          transition: 'opacity 0.15s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '4px',
          cursor: 'pointer',
        });
        const wrapper = container?.parentElement;
        const mountTarget = wrapper ?? document.body;
        if (wrapper && getComputedStyle(wrapper).position === 'static') {
          wrapper.style.position = 'relative';
        }
        mountTarget.appendChild(floatingCopyBtn);

        floatingCopyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!currentPre) return;
          const code = currentPre.querySelector('code');
          if (!code) return;
          navigator.clipboard.writeText(code.textContent || '').catch((err) => {
            getLogger().warn('Failed to copy code block:', err);
          });
          if (floatingCopyBtn) {
            floatingCopyBtn.innerHTML = checkIconSvg;
            setTimeout(() => {
              if (floatingCopyBtn) floatingCopyBtn.innerHTML = copyIconSvg;
            }, 1500);
          }
        });
      }
      return floatingCopyBtn;
    };

    const showCopyButton = (pre: HTMLElement): void => {
      const code = pre.querySelector('code');
      if (!code) return;

      const btn = getCopyButton();
      currentPre = pre;

      const wrapperRect = container?.parentElement?.getBoundingClientRect();
      const preRect = pre.getBoundingClientRect();
      if (wrapperRect) {
        btn.style.top = `${preRect.top - wrapperRect.top + 8}px`;
        btn.style.right = `${wrapperRect.right - preRect.right + 8}px`;
      }
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    };

    const hideCopyButton = (): void => {
      if (floatingCopyBtn) {
        floatingCopyBtn.style.opacity = '0';
        floatingCopyBtn.style.pointerEvents = 'none';
      }
      currentPre = null;
    };

    const configure = (withCollab: boolean) => {
      let next = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          if (fallbackInitialValue) {
            ctx.set(defaultValueCtx, fallbackInitialValue);
          }

          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChange?.(markdown);
          });

          ctx.get(listenerCtx).updated((_ctx) => {
            const suggest = onWikiLinkSuggestRef.current;
            const suggestSlash = onSlashMenuSuggestRef.current;

            const view = _ctx.get(editorViewCtx);
            const { selection } = view.state;

            if (!selection.empty) {
              suggest?.(false, '', null);
              suggestSlash?.(false, '', null, null);
              return;
            }

            const { $from } = selection;
            const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');

            const match = textBefore.match(/\[\[([^\]]*)$/);
            if (match) {
              const query = match[1] || '';
              const coords = view.coordsAtPos($from.pos);
              suggest?.(true, query, {
                x: coords.left,
                y: coords.bottom + 5,
                top: coords.top,
                bottom: coords.bottom,
              });
              suggestSlash?.(false, '', null, null);
            } else {
              suggest?.(false, '', null);

              if (!suggestSlash) {
                return;
              }

              const slashIndex = textBefore.lastIndexOf('/');
              if (slashIndex < 0) {
                suggestSlash(false, '', null, null);
                return;
              }

              const prefixChar = slashIndex === 0 ? '' : (textBefore[slashIndex - 1] ?? '');
              if (prefixChar && !/\s/.test(prefixChar)) {
                suggestSlash(false, '', null, null);
                return;
              }

              const query = textBefore.slice(slashIndex + 1);

              if (query && /\s/.test(query)) {
                suggestSlash(false, '', null, null);
                return;
              }

              const coords = view.coordsAtPos($from.pos);
              const slashFrom = $from.start() + slashIndex;
              suggestSlash(
                true,
                query,
                {
                  x: coords.left,
                  y: coords.bottom + 5,
                  top: coords.top,
                  bottom: coords.bottom,
                },
                { from: slashFrom, to: $from.pos },
              );
            }
          });

          if (withCollab) {
            ctx.get(collabServiceCtx).setOptions({
              yCursorOpts: {
                cursorBuilder,
              },
            });
          }

          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: {
              class: 'milkdown-editor-view',
              spellcheck: 'false',
            },
            handlePaste: (_view, event) => {
              const text = event.clipboardData?.getData('text/plain') ?? '';
              if (!text) return false;

              if (isLikelyTableData(text)) {
                const markdown = convertDelimitedToMarkdown(text);
                editorRef.current?.action(insert(markdown));
                return true;
              }

              if (!isLikelyMarkdown(text)) {
                return false;
              }

              editorRef.current?.action(insert(text));
              return true;
            },
            handleDOMEvents: {
              keydown: (view, event) => {
                const { state, dispatch } = view;
                if (!isInTable(state)) return false;

                if (event.key === 'Tab') {
                  event.preventDefault();
                  const direction = event.shiftKey ? -1 : 1;
                  goToNextCell(direction)(state, dispatch);
                  return true;
                }
                return false;
              },
              mousedown: (view, event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return false;

                const taskItem = target.closest('li[data-item-type="task"]');
                if (taskItem instanceof HTMLElement) {
                  const rect = taskItem.getBoundingClientRect();
                  const clickX = event.clientX - rect.left;
                  const clickY = event.clientY - rect.top;
                  const isCheckboxClick = clickX <= 28 && clickY <= 28;
                  if (!isCheckboxClick) return false;

                  event.preventDefault();
                  event.stopPropagation();

                  const result = findListItemAncestor(view, view.posAtDOM(taskItem, 0));
                  if (result) {
                    const { node, pos } = result;
                    const checked = node.attrs.checked;
                    const nextChecked = !isTaskChecked(checked);
                    const tr = view.state.tr.setNodeMarkup(pos, undefined, {
                      ...node.attrs,
                      checked: nextChecked,
                    });
                    view.dispatch(tr);
                  }
                  return true;
                }

                const anchor = target.closest('a[href]');
                if (anchor instanceof HTMLAnchorElement && anchor.classList.contains('wiki-link')) {
                  event.preventDefault();
                  event.stopPropagation();

                  linkEditor.close();

                  // Resolve by UUID first (stable across renames), fall back to
                  // title-based path matching for legacy links without targetId.
                  const targetId = anchor.getAttribute('data-target-id') || '';
                  if (targetId && onWikiLinkClickRef.current) {
                    // handleWikiLinkClick checks p.id === targetId, which is a
                    // UUID match — resilient to title changes.
                    onWikiLinkClickRef.current(targetId);
                  } else {
                    const path = anchor.getAttribute('data-path') || '';
                    const heading = anchor.getAttribute('data-heading') || '';
                    // Strip #heading suffix from path if present, since
                    // handleWikiLinkClick resolves by title match and a
                    // "#Heading" suffix would never match a page title.
                    const pagePath =
                      heading && path.endsWith(`#${heading}`)
                        ? path.slice(0, -(heading.length + 1))
                        : path;
                    if (pagePath && onWikiLinkClickRef.current) {
                      onWikiLinkClickRef.current(pagePath);
                    } else if (heading) {
                      scrollToHeading(heading);
                    }
                  }
                  return true;
                }

                return false;
              },
              click: (_view, event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return false;

                const anchor = target.closest('a[href]');
                if (!(anchor instanceof HTMLAnchorElement)) return false;

                if (anchor.classList.contains('wiki-link')) {
                  return true;
                }

                const href = anchor.getAttribute('href') || '';
                if (!href || href === '#') return false;

                if (href.startsWith('#')) {
                  event.preventDefault();
                  const headingId = href.slice(1);
                  const element = document.getElementById(headingId);
                  if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                  return true;
                }

                event.preventDefault();
                linkEditor.close();
                window.open(ensureAbsoluteUrl(href), '_blank', 'noopener,noreferrer');
                return true;
              },
              mouseover: (view, event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return false;

                const pre = target.closest('pre');
                if (pre instanceof HTMLElement) {
                  if (currentPre !== pre) {
                    showCopyButton(pre);
                  }
                } else if (currentPre && !currentPre.contains(target)) {
                  hideCopyButton();
                }

                const anchor = target.closest('a[href]');
                if (!(anchor instanceof HTMLAnchorElement)) return false;

                if (anchor.classList.contains('wiki-link')) {
                  // Wiki links resolve automatically — no link editor needed.
                  return true;
                }

                const href = anchor.getAttribute('href') || '';
                if (!href || href === '#') return false;

                const markFrom = view.posAtDOM(anchor, 0);
                const markTo = view.posAtDOM(anchor, anchor.childNodes.length);
                if (markFrom >= markTo) return false;

                const linkMarkType = view.state.schema.marks.link;
                if (!linkMarkType) return false;

                const hasLink = view.state.doc.rangeHasMark(markFrom, markTo, linkMarkType);
                if (!hasLink) return false;

                linkEditor.open(view, anchor, {
                  initialUrl: href,
                  initialText: anchor.textContent || href,
                  onConfirm: ({ url, text }) => {
                    const tr = view.state.tr;
                    tr.removeMark(markFrom, markTo, linkMarkType);
                    tr.replaceWith(
                      markFrom,
                      markTo,
                      view.state.schema.text(text, [
                        linkMarkType.create({ href: ensureAbsoluteUrl(url) }),
                      ]),
                    );
                    view.dispatch(tr);
                  },
                  onRemove: () => {
                    const tr = view.state.tr.removeMark(markFrom, markTo, linkMarkType);
                    view.dispatch(tr);
                  },
                });
                return true;
              },
              mouseout: (_view, event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return false;
                if (currentPre && !currentPre.contains(target)) {
                  hideCopyButton();
                }
                return false;
              },
            },
          }));
        })
        .use(commonmark)
        .use(gfm)
        .use(wikiLink)
        .use(wikiLinkView)
        .use(callout)
        .use(tag)
        .use(autolink)
        .use(remarkMathPlugin)
        .use(remarkMathBlockPlugin)
        .use(mathInlineSchema)
        .use(mathInlineInputRule)
        .use(mathBlockInputRule)
        .use(toggleLatexCommand)
        .use(mathInlineViewPlugin)
        .use(latexCodeBlockViewPlugin)
        .use(mathEditorTooltipPlugin)
        .use(listener);

      if (withCollab) {
        next = next.use(collab);
      }

      return next;
    };

    const bindWindowApi = () => {
      window.getEditorMarkdown = () => {
        if (!editorRef.current) return '';
        return editorRef.current.action(getMarkdown());
      };

      window.insertMarkdown = (content: string) => {
        if (!editorRef.current) return;
        editorRef.current.action(insert(content));
      };

      window.replaceAllMarkdown = (content: string) => {
        if (!editorRef.current) return;
        editorRef.current.action(replaceAll(content));
      };
    };

    const init = async () => {
      const shouldUseCollab = hasCollab;
      getLogger()
        .debug`Init: shouldUseCollab=${shouldUseCollab}, doc=${!!doc}, provider=${!!provider}`;
      try {
        runtimeEditor = await configure(shouldUseCollab).create();
      } catch {
        runtimeEditor = await configure(false).create();
      }

      if (disposed || !runtimeEditor) {
        runtimeEditor?.destroy();
        return;
      }

      if (shouldUseCollab && doc) {
        // syncHeadingIdPlugin dispatches setNodeMarkup transactions on every
        // doc update to assign heading IDs. y-prosemirror's ySyncPlugin then
        // syncs those mutations to the Y.Doc, which triggers observeDeep,
        // which re-renders ProseMirror, which fires syncHeadingIdPlugin again.
        // Milkdown's own vanilla-collab example removes this plugin in collab
        // mode. We also defer connect via setTimeout(0) so Milkdown processes
        // the plugin removal before ySyncPlugin is injected.
        runtimeEditor.remove(syncHeadingIdPlugin);
        setTimeout(() => {
          if (disposed || !runtimeEditor) return;
          runtimeEditor.action((ctx) => {
            const collabService = ctx.get(collabServiceCtx);
            collabService.bindDoc(doc);
            if (provider) {
              const awareness = provider.awareness;
              if (awareness) {
                collabService.setAwareness(awareness);
              }
              collabService.connect();
            }
          });
        }, 0);
      }

      editorRef.current = runtimeEditor;
      setEditorInstance(runtimeEditor);
      bindWindowApi();

      runtimeEditor.action((ctx) => {
        const view = ctx.get(editorViewCtx) as
          | import('@milkdown/kit/prose/view').EditorView
          | undefined;
        if (view) {
          setTimeout(() => {
            if (disposed) return;
            repairDocument(view);
          }, 500);
        }
      });
    };

    void init();

    return () => {
      disposed = true;
      // Disconnect collab before destroying the editor so Yjs updates
      // arriving as the WebSocket closes don't dispatch on destroyed context
      if (hasCollab && runtimeEditor) {
        try {
          runtimeEditor.action((ctx) => {
            ctx.get(collabServiceCtx).disconnect();
          });
        } catch {
          // Editor or collab already torn down
        }
      }
      runtimeEditor?.destroy();
      editorRef.current = null;
      setEditorInstance(null);
      if (floatingCopyBtn) {
        floatingCopyBtn.remove();
        floatingCopyBtn = null;
      }
    };
  }, [container, fallbackInitialValue, hasCollab, onChange, doc, provider]);

  return { setContainer, editor: editorInstance };
}
