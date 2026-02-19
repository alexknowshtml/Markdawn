import React, { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Briefcase, ChevronDown, Plus } from "lucide-react";
import { useWorkspaces } from "../../hooks/use-workspaces";

type WorkspaceSelectorProps = {
  onCreateWorkspace: () => void;
};

export function WorkspaceSelector({ onCreateWorkspace }: WorkspaceSelectorProps) {
  const navigate = useNavigate();
  const params = useParams();
  const { data: workspaces, isLoading } = useWorkspaces();
  const [open, setOpen] = useState(false);

  const currentWorkspace = useMemo(() => {
    if (!workspaces) return null;
    return workspaces.find((workspace) => workspace.slug === params.workspaceSlug) ?? null;
  }, [workspaces, params.workspaceSlug]);

  const handleNavigate = (slug: string) => {
    setOpen(false);
    navigate(`/app/${slug}`);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full h-9 px-2.5 rounded-md border border-zinc-200 bg-white/70 text-left text-sm font-semibold text-zinc-900 hover:bg-white transition-colors flex items-center gap-2"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-900 text-white">
          <Briefcase size={14} />
        </span>
        <span className="flex-1 truncate">
          {isLoading ? "Loading..." : currentWorkspace?.name ?? "Select workspace"}
        </span>
        <ChevronDown size={16} className="text-zinc-500" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg z-20">
          <div className="max-h-64 overflow-auto">
            {(workspaces ?? []).map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => handleNavigate(workspace.slug)}
                className="w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 transition-colors flex items-center gap-2"
              >
                <span className="h-2 w-2 rounded-full bg-zinc-400" />
                <span className="truncate">{workspace.name}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-zinc-200">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateWorkspace();
              }}
              className="w-full px-3 py-2 text-left text-sm text-zinc-900 hover:bg-zinc-50 transition-colors flex items-center gap-2"
            >
              <Plus size={16} className="text-zinc-500" />
              Create Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
