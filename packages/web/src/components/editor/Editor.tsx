import "@blocknote/mantine/style.css";
import { codeBlockOptions } from "@blocknote/code-block";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";
import { usePages } from "../../hooks/use-pages";
import { useWorkspace } from "../../hooks/use-workspaces";
import { customSchema } from "../../editor/schema";
import { getCustomSlashMenuItems } from "../../editor/slashMenu";
import { MarkdownView } from "./MarkdownView";
import { WikiLinkSuggestions } from "./WikiLinkSuggestions";

interface EditorProps {
  pageId: string;
  showRaw?: boolean;
  onProviderReady?: (provider: HocuspocusProvider) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
  onEditorReady?: (editor: any) => void;
}

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? "ws://localhost:1234";
const API_BASE = '/api';

const COLLAB_COLORS = [
  "#958DF1",
  "#F98181",
  "#FBBC88",
  "#FAF594",
  "#70E2FF",
  "#B9ED90",
  "#646464",
  "#ef4444",
];

function getCollabColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % COLLAB_COLORS.length;
  return COLLAB_COLORS[index] ?? COLLAB_COLORS[0];
}

export function Editor({ pageId, showRaw = false, onProviderReady, onStatusChange, onEditorReady }: EditorProps) {
  const { isDark } = useTheme();
  const { data: session } = useAuth();
  const navigate = useNavigate();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const userId = session?.user?.id ?? session?.user?.email ?? "";
  const userName = session?.user?.name ?? "Anonymous";
  const userColor = useMemo(() => getCollabColor(userId || userName) ?? "#958DF1", [userId, userName]);
  const token = useMemo(() => session?.session?.token ?? "", [session?.session?.token]);
  const [wikiQuery, setWikiQuery] = useState("");
  const [isWikiOpen, setIsWikiOpen] = useState(false);
  const [wikiPosition, setWikiPosition] = useState<{ x: number; y: number } | null>(null);
  const [wikiRange, setWikiRange] = useState<{ from: number; to: number } | null>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const { data: workspace } = useWorkspace(workspaceSlug);
  const { data: pages } = usePages(workspace?.id ?? "");
  const doc = useMemo(() => new Y.Doc(), [pageId]);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: COLLAB_URL,
        name: pageId,
        token,
        document: doc,
        forceSyncInterval: 15000,
        onStatus: ({ status }) => {
          onStatusChange?.(status);
        },
        onSynced: ({ state }) => {
          if (state) {
            onStatusChange?.(WebSocketStatus.Connected);
          }
        },
        onAuthenticationFailed: () => {
          onStatusChange?.(WebSocketStatus.Disconnected);
        },
      }),
    [doc, onStatusChange, pageId, token]
  );

  useEffect(() => {
    onStatusChange?.(WebSocketStatus.Connecting);
    onProviderReady?.(provider);
  }, [onProviderReady, onStatusChange, provider]);

  useEffect(() => {
    return () => {
      provider.destroy();
      doc.destroy();
    };
  }, [doc, provider]);

  // Known issue: undo/redo disabled with collaboration
  const editor = useCreateBlockNote({
    collaboration: {
      provider: provider as any,
      fragment: doc.getXmlFragment("document-store"),
      user: {
        name: userName,
        color: userColor,
      },
    },
    schema: customSchema,
    uploadFile: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/uploads`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Failed to upload image");
      }

      const data = (await res.json()) as { url?: string };
      if (!data.url) {
        throw new Error("Upload response missing URL");
      }

      return data.url;
    },
    codeBlock: { ...codeBlockOptions, defaultLanguage: "typescript" },
  }, [pageId, provider, doc, userName, userColor]) as any;

  const slashMenuItems = useMemo(() => (editor ? getCustomSlashMenuItems(editor as any) : []), [editor]);

  useEffect(() => {
    if (editor) {
      onEditorReady?.(editor);
    }
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor) return;
    const tiptapEditor = (editor as any)?._tiptapEditor;
    if (!tiptapEditor) return;

    const handleChange = () => {
      const { state, view } = tiptapEditor;
      const { from } = state.selection;
      const textBefore = state.doc.textBetween(Math.max(0, from - 200), from, "\n", "\n");
      const match = textBefore.match(/\[\[([^\]]*)$/);

      if (!match) {
        setIsWikiOpen(false);
        setWikiQuery("");
        setWikiRange(null);
        return;
      }

      const query = match[1] ?? "";
      const startOffset = match[0].length;
      const fromPos = Math.max(0, from - startOffset);

      const coords = view.coordsAtPos(from);
      const containerRect = editorWrapperRef.current?.getBoundingClientRect();
      const x = containerRect ? coords.left - containerRect.left : coords.left;
      const y = containerRect ? coords.bottom - containerRect.top + 8 : coords.bottom + 8;

      setWikiQuery(query);
      setWikiRange({ from: fromPos, to: from });
      setWikiPosition({ x, y });
      setIsWikiOpen(true);
    };

    tiptapEditor.on("update", handleChange);
    tiptapEditor.on("selectionUpdate", handleChange);
    return () => {
      tiptapEditor.off("update", handleChange);
      tiptapEditor.off("selectionUpdate", handleChange);
    };
  }, [editor]);

  const handleWikiSelect = (page: { id: string; title: string; icon: string | null }) => {
    if (!editor || !wikiRange || !workspaceSlug) return;
    const tiptapEditor = (editor as any)?._tiptapEditor;
    if (!tiptapEditor) return;
    const linkText = `[[${page.title}]]`;
    const href = `/app/${workspaceSlug}/${page.id}`;

    tiptapEditor
      .chain()
      .focus()
      .insertContentAt(
        { from: wikiRange.from, to: wikiRange.to },
        [{ type: "text", text: linkText, marks: [{ type: "link", attrs: { href } }] }]
      )
      .run();
    setIsWikiOpen(false);
    setWikiQuery("");
    setWikiRange(null);
  };

  useEffect(() => {
    if (!editor) return;
    const tiptapEditor = (editor as any)?._tiptapEditor;
    if (!tiptapEditor) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest("a") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || !href.startsWith("/app/")) return;
      event.preventDefault();
      navigate(href);
    };

    tiptapEditor.view.dom.addEventListener("click", handleClick);
    return () => {
      tiptapEditor.view.dom.removeEventListener("click", handleClick);
    };
  }, [editor, navigate]);

  return (
    <div ref={editorWrapperRef} className="editor-wrapper min-h-[500px] relative">
      {showRaw ? (
        <MarkdownView editor={editor} />
      ) : (
        <BlockNoteView editor={editor as any} theme={isDark ? "dark" : "light"} slashMenu={false}>
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => filterSuggestionItems(slashMenuItems as any, query)}
          />
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) => {
              if (!editor || !workspaceSlug) return [];
              try {
                const res = await fetch(`${API_BASE}/workspaces/${workspaceSlug}`, {
                  credentials: "include",
                });
                if (!res.ok) {
                  return [];
                }
                const data = (await res.json()) as {
                  members: Array<{ user_id: string | null; name: string }>;
                };
                return filterSuggestionItems(
                  data.members.map((member) => ({
                    title: member.name,
                    onItemClick: () =>
                      editor.insertInlineContent([
                        { type: "mention", props: { userId: member.user_id ?? "", userName: member.name } },
                        " ",
                      ]),
                  })),
                  query
                );
              } catch {
                return [];
              }
            }}
          />
        </BlockNoteView>
      )}
      <WikiLinkSuggestions
        isOpen={isWikiOpen}
        query={wikiQuery}
        pages={pages ?? []}
        position={wikiPosition}
        onSelect={handleWikiSelect}
        onClose={() => setIsWikiOpen(false)}
      />
    </div>
  );
}