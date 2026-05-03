import { Briefcase, Check, ChevronDown, Plus } from 'lucide-react';
import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspaces } from '../../hooks/use-workspaces';

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
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const handleNavigate = (slug: string) => {
    setOpen(false);
    navigate(`/app/${slug}`);
  };

  return (
    <div className="relative z-[90]" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full h-10 px-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 text-left text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:bg-white/60 dark:hover:bg-white/10 transition-all duration-200 flex items-center gap-3 shadow-sm cursor-pointer"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-black dark:bg-white text-white dark:text-zinc-900 shadow-sm">
          <Briefcase size={14} strokeWidth={2.5} />
        </span>
        <span className="flex-1 truncate">
          {isLoading ? 'Loading...' : (currentWorkspace?.name ?? 'Select workspace')}
        </span>
        <ChevronDown
          size={16}
          className={`text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-2 overflow-hidden rounded-2xl border border-white/40 dark:border-zinc-700/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] z-[95] animate-scale-in origin-top">
          <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
            {(workspaces ?? []).map((workspace) => {
              const isActive = workspace.slug === params.workspaceSlug;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => handleNavigate(workspace.slug)}
                  className={`w-full px-2.5 py-2 text-left text-sm rounded-xl transition-all duration-150 flex items-center gap-2.5 cursor-pointer ${
                    isActive
                      ? 'bg-black/5 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 font-medium'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                      isActive
                        ? 'bg-black dark:bg-white text-white dark:text-zinc-900 shadow-sm'
                        : 'bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    <Briefcase size={14} strokeWidth={isActive ? 2.5 : 2} />
                  </span>
                  <span className="flex-1 truncate">{workspace.name}</span>
                  {isActive && <Check size={16} className="text-zinc-900 dark:text-zinc-100" />}
                </button>
              );
            })}
          </div>
          <div className="p-2 border-t border-black/5 dark:border-white/5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateWorkspace();
              }}
              className="w-full px-2.5 py-2 text-left text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition-all duration-150 flex items-center gap-2.5 cursor-pointer"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                <Plus size={16} strokeWidth={2.5} />
              </span>
              Create Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
