import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthIdentityBoundary } from './components/auth/AuthIdentityBoundary';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { ShareablePageRoute } from './components/auth/ShareablePageRoute';
import { ErrorBoundary } from './components/ErrorBoundary';
import Dashboard from './routes/Dashboard';
import FolderEntry from './routes/FolderEntry';
import ForgotPassword from './routes/ForgotPassword';
import Home from './routes/Home';
import Login from './routes/Login';
import PageEntry from './routes/PageEntry';
import ResetPassword from './routes/ResetPassword';
import Settings from './routes/Settings';
import SharedWithMe from './routes/SharedWithMe';
import Trash from './routes/Trash';

function App() {
  return (
    <ErrorBoundary>
      <div className="bg-white dark:bg-zinc-950 min-h-screen text-zinc-900 dark:text-zinc-50">
        <BrowserRouter>
          <AuthIdentityBoundary>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              <Route
                path="/app"
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="settings" element={<Settings />} />
                <Route path="trash" element={<Trash />} />
                <Route path="shared-with-me" element={<SharedWithMe />} />
              </Route>

              <Route
                path="/app/:slugAndId"
                element={
                  <ShareablePageRoute entityType="page">
                    <AppShell />
                  </ShareablePageRoute>
                }
              >
                <Route index element={<PageEntry />} />
              </Route>

              <Route
                path="/app/folder/:slugAndId"
                element={
                  <ShareablePageRoute entityType="folder">
                    <AppShell />
                  </ShareablePageRoute>
                }
              >
                <Route index element={<FolderEntry />} />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthIdentityBoundary>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}

export default App;
