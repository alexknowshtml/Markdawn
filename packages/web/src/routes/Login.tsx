import React from "react";
import { authClient } from "../lib/auth-client";

export default function Login() {
  const handleSocialSignIn = (provider: "github" | "google") => async () => {
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: "/app",
        errorCallbackURL: "/login",
      });
    } catch {
      window.location.assign("/login");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-center text-2xl font-bold text-zinc-900">Log In</h1>
        <p className="mb-6 text-center text-sm text-zinc-500">
          Continue with your preferred provider.
        </p>
        <div className="space-y-3">
          <button
            type="button"
            onClick={handleSocialSignIn("google")}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50"
          >
            Continue with Google
          </button>
          <button
            type="button"
            onClick={handleSocialSignIn("github")}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800"
          >
            Continue with GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
