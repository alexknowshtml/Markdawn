import "@blocknote/mantine/style.css";
import React, { useEffect, useMemo } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";

interface EditorProps {
  pageId: string;
  onProviderReady?: (provider: HocuspocusProvider) => void;
  onStatusChange?: (status: WebSocketStatus) => void;
}

const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? "ws://localhost:1234";

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

export function Editor({ pageId, onProviderReady, onStatusChange }: EditorProps) {
  const { isDark } = useTheme();
  const { data: session } = useAuth();
  const userId = session?.user?.id ?? session?.user?.email ?? "";
  const userName = session?.user?.name ?? "Anonymous";
  const userColor = useMemo(() => getCollabColor(userId || userName) ?? "#958DF1", [userId, userName]);
  const token = useMemo(() => session?.session?.token ?? "", [session?.session?.token]);
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
  }, [pageId, provider, doc, userName, userColor]);

  return (
    <div className="editor-wrapper min-h-[500px]">
      <BlockNoteView editor={editor as any} theme={isDark ? "dark" : "light"} />
    </div>
  );
}
