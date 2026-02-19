import React from 'react';
import { useParams } from 'react-router-dom';

export default function Page() {
  const { pageId } = useParams<{ pageId: string }>();

  return (
    <div className="max-w-3xl mx-auto">
      <div className="h-64 bg-zinc-100 rounded-lg mb-8 flex items-center justify-center text-zinc-400">
        Cover Image Placeholder
      </div>
      
      <h1 className="text-4xl font-bold text-zinc-900 mb-6 capitalize">
        {pageId?.replace(/-/g, ' ')}
      </h1>

      <div className="prose prose-zinc max-w-none">
        <p className="text-lg text-zinc-600 mb-4">
          This is where the BlockNote editor will go. For now, here is some placeholder content to demonstrate the layout.
        </p>
        <p className="mb-4">
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
        </p>
        <ul className="list-disc pl-5 mb-4 space-y-2">
          <li>Feature 1: Markdown support</li>
          <li>Feature 2: Real-time collaboration</li>
          <li>Feature 3: Rich media integration</li>
        </ul>
        <p>
          Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
        </p>
      </div>
    </div>
  );
}
