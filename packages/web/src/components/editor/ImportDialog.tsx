import React, { useRef, useState } from "react";

type ImportDialogProps = {
  pageId: string;
};

export function ImportDialog({ pageId }: ImportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const closeDialog = () => {
    setIsOpen(false);
    setError(null);
    setSuccess(false);
    setIsLoading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Please choose a markdown file.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const markdown = await file.text();
      const res = await fetch(`/api/pages/${pageId}/import/markdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown }),
      });
      if (!res.ok) {
        throw new Error("Failed to import markdown");
      }
      setSuccess(true);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-600 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
      >
        Import Markdown
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in"
          onClick={closeDialog}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-xl animate-slide-up"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Import markdown</h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Upload a .md file to replace this page content.</p>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Markdown file</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md"
                  className="mt-2 w-full rounded-md border-2 border-dashed border-zinc-300 dark:border-zinc-600 px-3 py-4 text-sm text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-800 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-100 dark:file:bg-zinc-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 dark:file:text-zinc-300 hover:file:bg-zinc-200 dark:hover:file:bg-zinc-600 transition-colors"
                  disabled={isLoading}
                  required
                />
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
                {success && <p className="mt-2 text-sm text-emerald-600">Import complete. Reloading...</p>}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeDialog}
                  className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50"
                  disabled={isLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-800 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors disabled:opacity-60"
                  disabled={isLoading}
                >
                  {isLoading ? "Importing..." : "Import"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
