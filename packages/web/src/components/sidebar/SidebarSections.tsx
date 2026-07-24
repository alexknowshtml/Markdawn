import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { SidebarEntityRow, type SidebarRowModel } from './SidebarEntityRow';
import type { SidebarTreeRuntime } from './sidebarRuntime';

export type SidebarAliasRow = {
  key: string;
  row: SidebarRowModel;
};

export function SidebarSection({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center px-1 mb-2 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-left"
      >
        {collapsed ? (
          <ChevronRight size={14} className="mr-1 shrink-0" />
        ) : (
          <ChevronDown size={14} className="mr-1 shrink-0" />
        )}
        <span>{title}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

export function SidebarAliasSection({
  title,
  collapsed,
  onToggle,
  rows,
  runtime,
}: {
  title: string;
  collapsed: boolean;
  onToggle(): void;
  rows: readonly SidebarAliasRow[];
  runtime: SidebarTreeRuntime;
}) {
  if (rows.length === 0) return null;
  return (
    <SidebarSection title={title} collapsed={collapsed} onToggle={onToggle}>
      <div className="space-y-0.5">
        {rows.map(({ key, row }) => (
          <SidebarEntityRow key={key} runtime={runtime} entity={row} placement="alias" />
        ))}
      </div>
    </SidebarSection>
  );
}
