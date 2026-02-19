import React from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

export function AppShell() {
  return (
    <div className="flex h-screen w-full bg-white overflow-hidden text-zinc-900 font-sans">
      <Sidebar className="hidden md:flex flex-shrink-0" />
      
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <Header />
        
        <div className="flex-1 overflow-y-auto bg-white scroll-smooth">
          <div className="max-w-4xl mx-auto w-full p-6 md:p-12 min-h-full">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
