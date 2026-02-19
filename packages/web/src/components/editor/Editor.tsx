import "@blocknote/mantine/style.css";
import React from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";

export function Editor() {
  const editor = useCreateBlockNote();

  return (
    <div className="editor-wrapper min-h-[500px]">
      <BlockNoteView editor={editor as any} theme="light" />
    </div>
  );
}
