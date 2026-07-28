import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HeaderActions } from '../components/HeaderActions';
import { useIdentityLifecycle } from '../contexts/IdentityLifecycleContext';
import { authClient } from '../lib/auth-client';

export default function Login() {
  const identityLifecycle = useIdentityLifecycle();
  const location = useLocation();
  const returnLocation = (
    location.state as {
      from?: { pathname?: unknown; search?: unknown; hash?: unknown };
    } | null
  )?.from;
  const returnPath =
    typeof returnLocation?.pathname === 'string' && returnLocation.pathname.startsWith('/')
      ? `${returnLocation.pathname}${typeof returnLocation.search === 'string' ? returnLocation.search : ''}${typeof returnLocation.hash === 'string' ? returnLocation.hash : ''}`
      : '/app';

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'signin') {
        const result = await authClient.signIn.email({
          email,
          password,
          callbackURL: returnPath,
        });
        if (result.error) setError(result.error.message ?? 'Sign in failed');
      } else {
        const result = await authClient.signUp.email({
          email,
          password,
          name,
          callbackURL: returnPath,
        });
        if (result.error) setError(result.error.message ?? 'Sign up failed');
      }
    } catch {
      if (!identityLifecycle.isActive()) return;
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="absolute top-4 right-4">
        <HeaderActions />
      </div>
      <div className="w-full max-w-sm animate-fade-in rounded-lg border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-2 text-center text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          {mode === 'signin' ? 'Log In' : 'Create Account'}
        </h1>
        <p className="mb-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {mode === 'signin' ? 'Sign in to your workspace.' : 'Set up your account.'}
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ fontSize: '16px' }}
              className="w-full rounded-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:placeholder-zinc-500"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ fontSize: '16px' }}
            className="w-full rounded-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:placeholder-zinc-500"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ fontSize: '16px' }}
            className="w-full rounded-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:placeholder-zinc-500"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full cursor-pointer rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? 'Please wait...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError('');
            }}
            className="text-zinc-900 underline dark:text-zinc-100"
          >
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
        {mode === 'signin' && (
          <p className="mt-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
            <Link to="/forgot-password" className="text-zinc-900 underline dark:text-zinc-100">
              Forgot password?
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
