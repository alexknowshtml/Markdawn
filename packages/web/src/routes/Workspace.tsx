import React from 'react';
import { useParams, Link } from 'react-router-dom';

export default function Workspace() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-zinc-900 capitalize">{workspaceSlug} Workspace</h1>
        <button className="px-4 py-2 bg-zinc-900 text-white rounded-md text-sm hover:bg-zinc-800 transition-colors">
          New Page
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5].map((id) => (
          <Link 
            key={id}
            to={`/app/${workspaceSlug}/page-${id}`}
            className="block p-6 bg-white border border-zinc-200 rounded-lg hover:border-zinc-400 hover:shadow-sm transition-all"
          >
            <div className="h-32 bg-zinc-50 rounded-md mb-4 flex items-center justify-center text-zinc-300">
              Cover Image
            </div>
            <h3 className="font-semibold text-zinc-900 mb-1">Project Note {id}</h3>
            <p className="text-sm text-zinc-500">Last edited 2 days ago</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
