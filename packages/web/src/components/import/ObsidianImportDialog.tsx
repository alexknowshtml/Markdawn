import React, { useState, useCallback } from "react";
import { directoryOpen } from "browser-fs-access";
import { FolderOpen, FileText, Image, AlertCircle, CheckCircle, Loader2, X } from "lucide-react";

interface VaultFile {
  path: string;
  content?: string;
  data?: string;
  mimeType?: string;
}

interface ImportPreview {
  notes: number;
  images: number;
  folders: number;
  tags: Set<string>;
}

interface ObsidianImportDialogProps {
  workspaceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Extracts tags from YAML frontmatter in Obsidian markdown files.
 * Works reliably in browser environment without gray-matter.
 * 
 * Supports:
 * - tags:\n  - experience\n  - life\n  - tech\n
 * - tag: single-tag
 * - tags: [tag1, tag2]
 */
function extractFrontmatterTags(content: string, tagSet: Set<string>): void {
  // Match YAML frontmatter: --- followed by YAML content followed by ---
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  
  if (!frontmatterMatch) return;
  
  const frontmatter = frontmatterMatch[1];
  if (!frontmatter) return;
  
  // Match tags as YAML array:
  // tags:
  //   - experience
  //   - life
  //   - tech
  const arrayMatch = frontmatter.match(/^tags:\s*\n((?:  - .+\n?)+)/m);
  if (arrayMatch && arrayMatch[1]) {
    const tagLines = arrayMatch[1];
    const tagMatches = tagLines.matchAll(/^  - (.+)$/gm);
    for (const match of tagMatches) {
      const tag = match[1]?.trim().toLowerCase();
      if (tag) tagSet.add(tag);
    }
  }
  
  // Match single tag: tag: value
  const singleTagMatch = frontmatter.match(/^tag:\s*(.+)$/m);
  if (singleTagMatch && singleTagMatch[1]) {
    const tag = singleTagMatch[1].trim().toLowerCase();
    if (tag) tagSet.add(tag);
  }
  
  // Match tags as inline array: tags: [tag1, tag2]
  const inlineArrayMatch = frontmatter.match(/^tags:\s*\[([^\]]+)\]$/m);
  if (inlineArrayMatch && inlineArrayMatch[1]) {
    const tags = inlineArrayMatch[1].split(",");
    for (const tag of tags) {
      const t = tag.trim().toLowerCase();
      if (t) tagSet.add(t);
    }
  }
}

export function ObsidianImportDialog({ workspaceId, onClose, onSuccess }: ObsidianImportDialogProps) {
  const [step, setStep] = useState<"select" | "preview" | "uploading" | "done" | "error">("select");
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{
    foldersCreated: number;
    pagesCreated: number;
    imagesUploaded: number;
    tagsCreated: number;
    backlinksCreated: number;
    errors: string[];
  } | null>(null);
  const [error, setError] = useState<string>("");

  const scanVault = useCallback(async () => {
    try {
      const dirHandle = await directoryOpen({ recursive: true });
      const scannedFiles: VaultFile[] = [];
      const tags = new Set<string>();
      let noteCount = 0;
      let imageCount = 0;
      const folderPaths = new Set<string>();

      const allPaths: string[] = [];
      for (const file of dirHandle as unknown as File[]) {
        const rawPath = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || file.name;
        allPaths.push(rawPath.replace(/\\/g, "/"));
      }

      const commonRoot = allPaths.length > 0 && allPaths.every((p) => p.startsWith(allPaths[0]!.split("/")[0] + "/"))
        ? allPaths[0]!.split("/")[0] + "/"
        : null;

      for (let i = 0; i < (dirHandle as unknown as File[]).length; i++) {
        const file = (dirHandle as unknown as File[])[i]!;
        let relativePath = allPaths[i]!;
        if (commonRoot && relativePath.startsWith(commonRoot)) {
          relativePath = relativePath.slice(commonRoot.length);
        }

        const pathParts = relativePath.split("/");
        if (pathParts.some((p) => p === ".obsidian")) continue;

        const dir = pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";

        if (file.name.endsWith(".md")) {
          if (dir) folderPaths.add(dir);
          const content = await file.text();
          scannedFiles.push({ path: relativePath, content });
          noteCount++;

          extractFrontmatterTags(content, tags);

          const HEX_ONLY = /^[0-9a-fA-F]+$/;
          const inlineTags = content.matchAll(/(?:^|\s)#([a-zA-Z0-9_\-\/]+)/g);
          for (const match of inlineTags) {
            const rawTag = match[1];
            if (!rawTag) continue;
            if (HEX_ONLY.test(rawTag) && (rawTag.length === 3 || rawTag.length === 6 || rawTag.length === 8)) {
              continue;
            }
            const tag = rawTag.toLowerCase();
            if (tag) tags.add(tag);
          }
        } else if (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|svg)$/i.test(file.name)) {
          if (dir) folderPaths.add(dir);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              const base64Data = result.split(",")[1] || "";
              resolve(base64Data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          scannedFiles.push({
            path: relativePath,
            data: base64,
            mimeType: file.type || "image/png",
          });
          imageCount++;
        }
      }

      setFiles(scannedFiles);
      setPreview({
        notes: noteCount,
        images: imageCount,
        folders: folderPaths.size,
        tags,
      });
      setStep("preview");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message || "Failed to read vault");
        setStep("error");
      }
    }
  }, []);

  const startImport = useCallback(async () => {
    setStep("uploading");
    setProgress(0);

    const totalFiles = files.length;

    try {
      const res = await fetch(`/api/import/obsidian?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ files }),
      });

      setProgress(100);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ message: "Import failed" }));
        throw new Error(errData.message || "Import failed");
      }

      const data = await res.json();
      setResult(data);
      setStep("done");
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
      setStep("error");
    }
  }, [files, workspaceId, onSuccess]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Import Obsidian Vault</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-6">
          {step === "select" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Select your Obsidian vault folder to import all notes, images, and tags.
              </p>
              <button
                onClick={scanVault}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 px-4 py-3 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
              >
                <FolderOpen size={18} />
                Select Vault Folder
              </button>
            </div>
          )}

          {step === "preview" && preview && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Found the following in your vault:</p>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-3 text-center">
                  <FileText size={20} className="mx-auto text-zinc-500 dark:text-zinc-400 mb-1" />
                  <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{preview.notes}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">Notes</div>
                </div>
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-3 text-center">
                  <Image size={20} className="mx-auto text-zinc-500 dark:text-zinc-400 mb-1" />
                  <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{preview.images}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">Images</div>
                </div>
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-3 text-center">
                  <FolderOpen size={20} className="mx-auto text-zinc-500 dark:text-zinc-400 mb-1" />
                  <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{preview.folders}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">Folders</div>
                </div>
              </div>

              {preview.tags.size > 0 && (
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Tags found:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(preview.tags).slice(0, 20).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300"
                      >
                        #{tag}
                      </span>
                    ))}
                    {preview.tags.size > 20 && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        +{preview.tags.size - 20} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep("select")}
                  className="flex-1 rounded-xl border border-zinc-200 dark:border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={startImport}
                  className="flex-1 rounded-xl bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
                >
                  Import Vault
                </button>
              </div>
            </div>
          )}

          {step === "uploading" && (
            <div className="py-8 text-center space-y-4">
              <Loader2 size={32} className="mx-auto animate-spin text-zinc-500 dark:text-zinc-400" />
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Importing your vault...</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  {files.length} files
                </p>
              </div>
              <div className="w-full h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-900 dark:bg-zinc-100 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-green-600 dark:text-green-400">
                <CheckCircle size={24} />
                <span className="font-medium">Import complete!</span>
              </div>

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">Folders created</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{result.foldersCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">Pages created</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{result.pagesCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">Images uploaded</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{result.imagesUploaded}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">Tags created</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{result.tagsCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">Backlinks indexed</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{result.backlinksCreated}</span>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">
                    {result.errors.length} warning{result.errors.length > 1 ? "s" : ""}
                  </p>
                  <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5 max-h-24 overflow-y-auto">
                    {result.errors.slice(0, 5).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {result.errors.length > 5 && (
                      <li>+{result.errors.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}

              <button
                onClick={onClose}
                className="w-full rounded-xl bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {step === "error" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-red-600 dark:text-red-400">
                <AlertCircle size={24} />
                <span className="font-medium">Import failed</span>
              </div>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
              <button
                onClick={() => setStep("select")}
                className="w-full rounded-xl bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
