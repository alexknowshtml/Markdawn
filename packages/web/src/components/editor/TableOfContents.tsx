import React, { useEffect, useMemo, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { X } from "lucide-react";

interface TableOfContentsProps {
  editor: BlockNoteEditor<any>;
  onClose: () => void;
}

type HeadingItem = {
  id: string;
  level: number;
  text: string;
};

function getHeadingText(block: unknown) {
  const content = (block as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content.map((item) => (item.type === "text" ? item.text ?? "" : "")).join("");
}

function extractHeadings(editor: BlockNoteEditor<any>): HeadingItem[] {
  return editor.document
    .filter((block) => block.type === "heading")
    .map((block) => ({
      id: block.id,
      level: block.props?.level ?? 1,
      text: getHeadingText(block) || "Untitled heading",
    }));
}

export function TableOfContents({ editor, onClose }: TableOfContentsProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>(() => extractHeadings(editor));

  useEffect(() => {
    const updateHeadings = () => {
      setHeadings(extractHeadings(editor));
    };

    updateHeadings();
    return editor.onChange(updateHeadings);
  }, [editor]);

  const handleHeadingClick = (headingId: string) => {
    editor.focus();
    const target =
      document.querySelector(`[data-id="${headingId}"]`) ??
      document.querySelector(`[data-block-id="${headingId}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const headingItems = useMemo(() => {
    return headings.map((heading) => (
      <button
        key={heading.id}
        type="button"
        onClick={() => handleHeadingClick(heading.id)}
        className="w-full text-left text-sm text-zinc-100/90 hover:text-white hover:bg-zinc-800/60 rounded-md px-2 py-1 transition-colors"
        style={{ paddingLeft: `${(heading.level - 1) * 16}px` }}
      >
        {heading.text}
      </button>
    ));
  }, [headings]);

  return (
    <aside className="fixed right-0 top-0 h-full w-[240px] bg-zinc-900 text-zinc-100 border-l border-zinc-700 shadow-xl z-50">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-xs font-semibold tracking-[0.2em] uppercase text-zinc-400">
          Table of Contents
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          title="Close table of contents"
        >
          <X size={16} />
        </button>
      </div>
      <div className="px-4 py-3 space-y-1 overflow-y-auto h-[calc(100%-52px)]">
        {headingItems.length > 0 ? (
          headingItems
        ) : (
          <div className="text-xs text-zinc-500">No headings yet.</div>
        )}
      </div>
    </aside>
  );
}
