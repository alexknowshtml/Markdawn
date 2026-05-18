import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { WorkspaceSettings } from './components/workspace/WorkspaceSettings';
import { ClipboardProvider } from './contexts/ClipboardContext';
import { KeyboardShortcutProvider } from './contexts/KeyboardShortcutContext';
import { SelectionProvider } from './contexts/SelectionContext';
import Dashboard from './routes/Dashboard';
import Home from './routes/Home';
import Login from './routes/Login';
import Page from './routes/Page';
import PublicPage from './routes/PublicPage';
import Workspace from './routes/Workspace';

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
                  <ClipboardProvider>
                    <SelectionProvider>
                      <KeyboardShortcutProvider>
                        <AppShell />
                      </KeyboardShortcutProvider>
                    </SelectionProvider>
                  </ClipboardProvider>
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path=":workspaceSlug" element={<Workspace />} />
              <Route path=":workspaceSlug/folder/:folderId" element={<Workspace />} />
              <Route path=":workspaceSlug/settings" element={<WorkspaceSettings />} />
              <Route path=":workspaceSlug/:slugAndId" element={<Page />} />
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
