import React, { useState } from "react";
import { Copy, Check, Globe, Lock } from "lucide-react";
import { useSharePage, useUnsharePage } from "../../hooks/use-share";
import { Page } from "@markdawn/shared";
import { showErrorToast } from "../../utils/toast";

type PublicShareDialogProps = {
  page: Page;
  onClose: () => void;
};

export function PublicShareDialog({ page, onClose }: PublicShareDialogProps) {
  const [copied, setCopied] = useState(false);
  const shareMutation = useSharePage();
  const unshareMutation = useUnsharePage();

  const isPublic = !!page.isPublic;
  const publicUrl = page.publicToken 
    ? `${window.location.origin}/public/${page.publicToken}`
    : "";

  const handleCopy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showErrorToast("Failed to copy link");
    }
  };

  const handleToggle = () => {
    if (isPublic) {
      unshareMutation.mutate(page.id);
    } else {
      shareMutation.mutate(page.id);
    }
  };

  const isLoading = shareMutation.isPending || unshareMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-xl animate-slide-up">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
            {isPublic ? <Globe className="w-5 h-5 text-green-500" /> : <Lock className="w-5 h-5 text-zinc-400" />}
            Share to web
          </h2>
        </div>
        
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
          {isPublic 
            ? "Anyone with the link can view this page." 
            : "Publish this page to the web to share it with anyone."}
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Public access
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {isPublic ? "On" : "Off"}
              </span>
            </div>
            
            <button
              onClick={handleToggle}
              disabled={isLoading}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10 ${
                isPublic ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-600"
              } ${isLoading ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  isPublic ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {isPublic && publicUrl && (
            <div className="animate-fade-in">
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">
                Public Link
              </label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={publicUrl}
                  className="flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-800 focus:outline-none"
                />
                <button
                  onClick={handleCopy}
                  className="flex items-center justify-center w-10 h-10 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
