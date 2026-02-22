import React from "react";

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-zinc-950 px-4">
        <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Something went wrong</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            The page crashed while rendering. You can safely return home.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
            className="mt-4 inline-flex items-center rounded-md bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }
}
