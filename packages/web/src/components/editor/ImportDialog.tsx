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
        className="px-3 py-2 text-sm font-medium text-zinc-700 border border-zinc-200 rounded-md hover:bg-zinc-100 transition-colors"
      >
        Import Markdown
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4"
          onClick={closeDialog}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-zinc-900">Import markdown</h2>
            <p className="mt-1 text-sm text-zinc-500">Upload a .md file to replace this page content.</p>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label className="text-sm font-medium text-zinc-700">Markdown file</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md"
                  className="mt-2 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-900 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200"
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
                  className="px-3 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                  disabled={isLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-md hover:bg-zinc-800 transition-colors disabled:opacity-60"
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
