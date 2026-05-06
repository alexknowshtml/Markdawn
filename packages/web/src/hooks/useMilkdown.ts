import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { getMarkdown, insert, replaceAll } from '@milkdown/utils';
import { useEffect, useRef, useState } from 'react';
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
import { wikiLink } from '../editor/plugins/wikilink';
import { repairDocument } from '../editor/utils/documentRepair';
import 'katex/dist/katex.min.css';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { getLogger } from '../logger-init';

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
    /\[[^\]]+\]\([^\)]+\)/,
    /\|.+\|/,
    /~~[^~]+~~/,
    /^- \[( |x)\]\s/m,
    /\$[^$]+\$/,
    /^\$\$[\s\S]*?\$\$$/m,
  ];

  return markdownSignals.some((pattern) => pattern.test(trimmed));
}

interface UseMilkdownProps {
  initialValue?: string;
  onChange?: (markdown: string) => void;
  doc?: Y.Doc;
  provider?: HocuspocusProvider;
  onWikiLinkClick?: ((path: string) => void) | undefined;
}

function isTaskChecked(checked: unknown): boolean {
  return checked === true || checked === 'true';
}

function isTaskListItem(checked: unknown): boolean {
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
}: UseMilkdownProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;
  const hasCollab = Boolean(doc && provider);
  const fallbackInitialValue = hasCollab ? undefined : initialValue;

  useEffect(() => {
    if (!container) return;
    let disposed = false;
    let runtimeEditor: Editor | null = null;

    let floatingCopyBtn: HTMLButtonElement | null = null;
    let currentPre: HTMLElement | null = null;

    const getCopyButton = (): HTMLButtonElement => {
      if (!floatingCopyBtn) {
        floatingCopyBtn = document.createElement('button');
        floatingCopyBtn.className = 'code-block-copy-btn';
        floatingCopyBtn.textContent = 'Copy';
        floatingCopyBtn.type = 'button';
        floatingCopyBtn.style.position = 'fixed';
        floatingCopyBtn.style.zIndex = '1000';
        floatingCopyBtn.style.opacity = '0';
        floatingCopyBtn.style.pointerEvents = 'none';
        floatingCopyBtn.style.transition = 'opacity 0.15s ease';
        document.body.appendChild(floatingCopyBtn);
      }
      return floatingCopyBtn;
    };

    const showCopyButton = (pre: HTMLElement): void => {
      const code = pre.querySelector('code');
      if (!code) return;

      const btn = getCopyButton();
      currentPre = pre;

      const rect = pre.getBoundingClientRect();
      btn.style.top = `${rect.top + 8}px`;
      btn.style.left = `${rect.right - 72}px`;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';

      const newBtn = btn.cloneNode(true) as HTMLButtonElement;
      btn.parentNode?.replaceChild(newBtn, btn);
      floatingCopyBtn = newBtn;

      floatingCopyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(code.textContent || '');
        if (floatingCopyBtn) {
          floatingCopyBtn.textContent = 'Copied!';
          setTimeout(() => {
            if (floatingCopyBtn) floatingCopyBtn.textContent = 'Copy';
          }, 1500);
        }
      });
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

          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: {
              class: 'milkdown-editor-view',
              spellcheck: 'false',
            },
            handlePaste: (_view, event) => {
              const text = event.clipboardData?.getData('text/plain') ?? '';
              if (!isLikelyMarkdown(text)) {
                return false;
              }

              editorRef.current?.action(insert(text));
              return true;
            },
            handleDOMEvents: {
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

                  const path = anchor.getAttribute('data-path') || '';
                  const heading = anchor.getAttribute('data-heading') || '';

                  linkEditor.close();

                  if (path && onWikiLinkClickRef.current) {
                    onWikiLinkClickRef.current(path);
                  } else if (heading) {
                    scrollToHeading(heading);
                  }
                  return true;
                }

                return false;
              },
              click: (view, event) => {
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
                window.open(href, '_blank', 'noopener,noreferrer');
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
                  const path = anchor.getAttribute('data-path') || '';
                  const heading = anchor.getAttribute('data-heading') || '';
                  const displayText = heading
                    ? path
                      ? `${path}#${heading}`
                      : `#${heading}`
                    : path || 'Wiki link';

                  const pos = view.posAtDOM(anchor, 0);
                  let wikiNode = view.state.doc.nodeAt(pos);
                  let from = pos;
                  let to = pos;
                  if (wikiNode && wikiNode.type.name === 'wikiLink') {
                    to = pos + wikiNode.nodeSize;
                  } else {
                    wikiNode = view.state.doc.nodeAt(pos - 1);
                    if (wikiNode && wikiNode.type.name === 'wikiLink') {
                      from = pos - 1;
                      to = from + wikiNode.nodeSize;
                    } else {
                      return false;
                    }
                  }

                  linkEditor.open(view, anchor, {
                    initialUrl: displayText,
                    initialText: anchor.textContent || displayText,
                    onConfirm: ({ text }) => {
                      const tr = view.state.tr;
                      tr.setNodeMarkup(from, undefined, { ...wikiNode.attrs, label: text });
                      view.dispatch(tr);
                    },
                    onRemove: () => {
                      const tr = view.state.tr.delete(from, to);
                      view.dispatch(tr);
                    },
                  });
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
                      view.state.schema.text(text, [linkMarkType.create({ href: url })]),
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

      if (shouldUseCollab && doc && provider) {
        runtimeEditor.action((ctx) => {
          const collabService = ctx.get(collabServiceCtx);
          collabService.bindDoc(doc);
          const awareness = provider.awareness;
          if (awareness) {
            collabService.setAwareness(awareness);
          }
          collabService.connect();
        });
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
            repairDocument(view);
          }, 500);
        }
      });
    };

    void init();

    return () => {
      disposed = true;
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
