import clsx from 'clsx';
import { Briefcase, ChevronDown, Plus, Users } from 'lucide-react';
import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspaces } from '../../hooks/use-workspaces';

interface WorkspacePillProps {
  className?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onCreateWorkspace: () => void;
}

export function WorkspacePill({
  className,
  collapsed = false,
  onToggleCollapsed,
  onCreateWorkspace,
}: WorkspacePillProps) {
  const navigate = useNavigate();
  const params = useParams();
  const workspaceSlug = params.workspaceSlug;

  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces();
  const [showDropdown, setShowDropdown] = useState(false);

  const currentWorkspace = workspaces?.find((w) => w.slug === workspaceSlug);

  const handleNavigate = (slug: string) => {
    setShowDropdown(false);
    navigate(`/app/${slug}`);
  };

  const isExpanded = !collapsed || showDropdown;

  return (
    <div
      className={clsx(
        'rounded-[2rem] border border-white/60 dark:border-zinc-700/50 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] flex-shrink-0 z-50 relative overflow-hidden flex flex-col justify-center',
        isExpanded ? 'w-[240px] p-3 flex flex-col' : 'w-[68px] min-h-[80px] py-3 flex flex-col',
        className,
      )}
    >
      {!isExpanded && (
        <button
          type="button"
          onClick={() => setShowDropdown(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setShowDropdown(true);
            }
          }}
          className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer bg-transparent border-0 p-0 m-0 text-inherit"
        >
          <div className="w-10 h-10 rounded-2xl bg-zinc-800 dark:bg-zinc-200 flex items-center justify-center text-white dark:text-zinc-900 font-bold text-sm shadow-md">
            {currentWorkspace?.name?.[0]?.toUpperCase() ?? <Briefcase size={18} />}
          </div>
        </button>
      )}

      {isExpanded && (
        <div className="w-full">
          {showDropdown && collapsed && (
            <button
              type="button"
              onClick={() => setShowDropdown(false)}
              className="absolute top-2 right-2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer"
            >
              ×
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowDropdown(!showDropdown)}
            className="w-full h-10 px-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 text-left text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:bg-white/60 dark:hover:bg-white/10 transition-all duration-200 flex items-center gap-3 shadow-sm cursor-pointer"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-black dark:bg-white text-white dark:text-zinc-900 shadow-sm">
              <Briefcase size={14} strokeWidth={2.5} />
            </span>
            <span className="flex-1 truncate">
              {isLoadingWorkspaces ? 'Loading...' : (currentWorkspace?.name ?? 'Select workspace')}
            </span>
            <ChevronDown
              size={16}
              className={`text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`}
            />
          </button>

          {showDropdown && (
            <div className="mt-2 overflow-hidden rounded-2xl border border-white/40 dark:border-zinc-700/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] animate-scale-in">
              <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
                {(workspaces ?? []).map((workspace) => {
                  const isActive = workspace.slug === workspaceSlug;
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
                    </button>
                  );
                })}
              </div>
              <div className="p-2 border-t border-black/5 dark:border-white/5">
                <button
                  type="button"
                  onClick={() => {
                    setShowDropdown(false);
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

          <div className="mt-auto pt-2">
            <button
              type="button"
              className="p-2 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
              title="Invite members"
            >
              <Users size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
