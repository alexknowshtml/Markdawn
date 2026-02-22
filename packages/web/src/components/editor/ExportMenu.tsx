import React, { useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { showErrorToast, showSuccessToast } from "../../utils/toast";

type ExportMenuProps = {
  pageTitle: string;
  editor: BlockNoteEditor<any> | null;
};

export function ExportMenu({ pageTitle, editor }: ExportMenuProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleExport = async () => {
    if (!editor) {
      showErrorToast("Editor not ready for export");
      return;
    }

    setIsLoading(true);
    try {
      const serialized = await editor.blocksToMarkdownLossy(editor.document);
      const title = pageTitle.trim().length > 0 ? pageTitle.trim() : "Untitled";
      const markdown = `# ${title}\n\n${serialized}`;
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title}.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccessToast("Markdown exported");
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={isLoading}
        className="px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-600 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-60"
      >
        {isLoading ? "Exporting..." : "Export Markdown"}
      </button>
    </div>
  );
}
