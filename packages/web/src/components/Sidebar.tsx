import React from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

export function Sidebar({ className }: { className?: string }) {
  return (
    <aside className={clsx(
      "w-64 border-r border-zinc-200 bg-zinc-50 h-full flex flex-col",
      className
    )}>
      <div className="p-4 border-b border-zinc-200 h-14 flex items-center">
        <h1 className="font-bold text-lg text-zinc-800">MarkDawn</h1>
      </div>
      
      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-2 py-1 mt-4">
          Workspaces
        </div>
        {/* Placeholder navigation items */}
        <NavLink 
          to="/app/demo" 
          className={({ isActive }) => clsx(
            "block px-2 py-1.5 rounded-md text-sm font-medium transition-colors",
            isActive ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          )}
        >
          Demo Workspace
        </NavLink>
        <NavLink 
          to="/app/personal" 
          className={({ isActive }) => clsx(
            "block px-2 py-1.5 rounded-md text-sm font-medium transition-colors",
            isActive ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          )}
        >
          Personal Notes
        </NavLink>
      </nav>

      <div className="p-4 border-t border-zinc-200">
        <NavLink 
          to="/login"
          className="block w-full px-4 py-2 text-sm text-center text-zinc-600 bg-white border border-zinc-300 rounded-md hover:bg-zinc-50"
        >
          Log Out
        </NavLink>
      </div>
    </aside>
  );
}
