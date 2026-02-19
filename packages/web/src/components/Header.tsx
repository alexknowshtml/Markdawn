import React from 'react';

export function Header() {
  return (
    <header className="h-14 border-b border-zinc-200 bg-white flex items-center px-4 justify-between sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-500">Workspace</span>
        <span className="text-zinc-300">/</span>
        <span className="text-sm font-semibold text-zinc-900">Current Page</span>
      </div>
      
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-zinc-200" />
      </div>
    </header>
  );
}
