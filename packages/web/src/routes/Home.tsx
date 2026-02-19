import React from 'react';
import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50">
      <h1 className="text-4xl font-bold text-zinc-900 mb-4">Welcome to MarkDawn</h1>
      <p className="text-zinc-600 mb-8">The modern markdown editor for your team.</p>
      <div className="flex gap-4">
        <Link to="/login" className="px-4 py-2 bg-zinc-900 text-white rounded-md hover:bg-zinc-800 transition-colors">
          Log In
        </Link>
        <Link to="/app" className="px-4 py-2 border border-zinc-300 bg-white text-zinc-700 rounded-md hover:bg-zinc-50 transition-colors">
          Go to App
        </Link>
      </div>
    </div>
  );
}
