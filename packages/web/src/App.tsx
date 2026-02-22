import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import Home from './routes/Home';
import Login from './routes/Login';
import Dashboard from './routes/Dashboard';
import Workspace from './routes/Workspace';
import Page from './routes/Page';
import { WorkspaceSettings } from './components/workspace/WorkspaceSettings';
import PublicPage from './routes/PublicPage';
import { ErrorBoundary } from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <div className="bg-white dark:bg-zinc-950 min-h-screen text-zinc-900 dark:text-zinc-50">
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />

            <Route
              path="/app"
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path=":workspaceSlug" element={<Workspace />} />
              <Route path=":workspaceSlug/settings" element={<WorkspaceSettings />} />
              <Route path=":workspaceSlug/:pageId" element={<Page />} />
            </Route>
            <Route path="/public/:token" element={<PublicPage />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}

export default App;
