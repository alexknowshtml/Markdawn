import React, { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";

interface MarkdownViewProps {
  editor: BlockNoteEditor | null;
}

export function MarkdownView({ editor }: MarkdownViewProps) {
  const [markdown, setMarkdown] = useState("Loading markdown...");

  useEffect(() => {
    let isActive = true;

    const loadMarkdown = async () => {
      if (!editor) {
        setMarkdown("No content available.");
        return;
      }

      try {
        const serialized = await editor.blocksToMarkdownLossy(editor.document);
        if (isActive) {
          setMarkdown(serialized);
        }
      } catch (error) {
        if (isActive) {
          setMarkdown("Failed to load markdown.");
        }
      }
    };

    void loadMarkdown();

    return () => {
      isActive = false;
    };
  }, [editor]);

  return (
    <textarea
      readOnly
      value={markdown}
      className="w-full h-full min-h-[500px] resize-none rounded-lg bg-zinc-900 text-zinc-100 font-mono text-sm p-4 outline-none border-0 focus:ring-0"
    />
  );
}
