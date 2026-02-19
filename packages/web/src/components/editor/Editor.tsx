import "@blocknote/mantine/style.css";
import React, { useMemo } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import type { PartialBlock } from "@blocknote/core";
import { usePageContent } from "../../hooks/usePageContent";

interface EditorProps {
  pageId: string;
}

export function Editor({ pageId }: EditorProps) {
  const { initialContent, saveStatus, onEditorChange, serializeContent } = usePageContent(pageId);
  const editorOptions = useMemo(
    () => (initialContent !== undefined ? { initialContent } : {}),
    [initialContent]
  );
  const editor = useCreateBlockNote(editorOptions);
  const saveLabel = useMemo(() => {
    if (saveStatus === "saving") return "Saving...";
    if (saveStatus === "saved") return "Saved";
    if (saveStatus === "error") return "Error saving";
    return "";
  }, [saveStatus]);
  const handleChange = () => {
    const content = editor.document as PartialBlock[];
    onEditorChange(serializeContent(content));
  };

  return (
    <div className="editor-wrapper min-h-[500px]">
      {saveLabel ? (
        <div className="text-xs text-zinc-500 mb-2">{saveLabel}</div>
      ) : null}
      <BlockNoteView editor={editor as any} theme="light" onChange={handleChange} />
    </div>
  );
}
