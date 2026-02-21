import React, { useMemo, useState, useRef, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Briefcase, ChevronDown, Plus, Check } from "lucide-react";
import { useWorkspaces } from "../../hooks/use-workspaces";

type WorkspaceSelectorProps = {
  onCreateWorkspace: () => void;
};

export function WorkspaceSelector({ onCreateWorkspace }: WorkspaceSelectorProps) {
  const navigate = useNavigate();
  const params = useParams();
  const { data: workspaces, isLoading } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentWorkspace = useMemo(() => {
    if (!workspaces) return null;
    return workspaces.find((workspace) => workspace.slug === params.workspaceSlug) ?? null;
  }, [workspaces, params.workspaceSlug]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  const handleNavigate = (slug: string) => {
    setOpen(false);
    navigate(`/app/${slug}`);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full h-10 px-3 rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900 text-left text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-200 flex items-center gap-3 shadow-sm"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-sm">
          <Briefcase size={14} strokeWidth={2.5} />
        </span>
        <span className="flex-1 truncate">
          {isLoading ? "Loading..." : currentWorkspace?.name ?? "Select workspace"}
        </span>
        <ChevronDown 
          size={16} 
          className={`text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`} 
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-2 overflow-hidden rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl z-20 animate-slide-up">
          <div className="max-h-[60vh] overflow-y-auto p-1.5 space-y-0.5">
            {(workspaces ?? []).map((workspace) => {
              const isActive = workspace.slug === params.workspaceSlug;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => handleNavigate(workspace.slug)}
                  className={`w-full px-2.5 py-2 text-left text-sm rounded-md transition-all duration-150 flex items-center gap-2.5 ${
                    isActive 
                      ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium" 
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                  }`}
                >
                  <span className={`flex h-6 w-6 items-center justify-center rounded-md ${
                    isActive 
                      ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900" 
                      : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                  }`}>
                    <Briefcase size={12} strokeWidth={isActive ? 2.5 : 2} />
                  </span>
                  <span className="flex-1 truncate">{workspace.name}</span>
                  {isActive && <Check size={16} className="text-zinc-900 dark:text-zinc-100" />}
                </button>
              );
            })}
          </div>
          <div className="p-1.5 border-t border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/50">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateWorkspace();
              }}
              className="w-full px-2.5 py-2 text-left text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-all duration-150 flex items-center gap-2.5"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                <Plus size={14} strokeWidth={2.5} />
              </span>
              Create Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
