import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProviders } from './components/AppProviders';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { ShareablePageRoute } from './components/auth/ShareablePageRoute';
import { ErrorBoundary } from './components/ErrorBoundary';
import Dashboard from './routes/Dashboard';
import Home from './routes/Home';
import Login from './routes/Login';
import PageEntry from './routes/PageEntry';
import Settings from './routes/Settings';
import Trash from './routes/Trash';

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
                  <AppProviders>
                    <AppShell />
                  </AppProviders>
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="settings" element={<Settings />} />
              <Route path="trash" element={<Trash />} />
            </Route>

            <Route
              path="/app/:slugAndId"
              element={
                <ShareablePageRoute>
                  <AppProviders>
                    <AppShell />
                  </AppProviders>
                </ShareablePageRoute>
              }
            >
              <Route index element={<PageEntry />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}

export default App;
