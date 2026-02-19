import "@blocknote/mantine/style.css";
import React, { useEffect, useMemo } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { useAuth } from "../../hooks/useAuth";
import { authClient } from "../../lib/auth-client";
import { useTheme } from "../../hooks/useTheme";

interface EditorProps {
  pageId: string;
  onProviderReady?: (provider: HocuspocusProvider) => void;
}

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

export function Editor({ pageId, onProviderReady }: EditorProps) {
  const { isDark } = useTheme();
  const { data: session } = useAuth();
  const userId = session?.user?.id ?? session?.user?.email ?? "";
  const userName = session?.user?.name ?? "Anonymous";
  const userColor = useMemo(() => getCollabColor(userId || userName) ?? "#958DF1", [userId, userName]);
  const token = useMemo(() => session?.session?.token ?? "", [session?.user?.id]);
  const doc = useMemo(() => new Y.Doc(), [pageId]);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: "ws://localhost:1234",
        name: pageId,
        token,
        document: doc,
      }),
    [doc, pageId, token]
  );

  useEffect(() => {
    onProviderReady?.(provider);
  }, [onProviderReady, provider]);

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
  });

  return (
    <div className="editor-wrapper min-h-[500px]">
      <BlockNoteView editor={editor as any} theme={isDark ? "dark" : "light"} />
    </div>
  );
}
