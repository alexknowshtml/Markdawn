import React from 'react';

export default function Login() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50">
      <div className="w-full max-w-sm p-8 bg-white border border-zinc-200 rounded-lg shadow-sm">
        <h1 className="text-2xl font-bold text-center text-zinc-900 mb-6">Log In</h1>
        <form className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Email</label>
            <input type="email" className="w-full px-3 py-2 border border-zinc-300 rounded-md focus:outline-none focus:ring-2 focus:ring-zinc-900" placeholder="you@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Password</label>
            <input type="password" className="w-full px-3 py-2 border border-zinc-300 rounded-md focus:outline-none focus:ring-2 focus:ring-zinc-900" placeholder="••••••••" />
          </div>
          <button type="button" className="w-full py-2 bg-zinc-900 text-white rounded-md hover:bg-zinc-800 transition-colors">
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
