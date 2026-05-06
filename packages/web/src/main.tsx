import { MantineProvider, type MantineTheme, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';
import App from './App';
import { getLogger, initLogger } from './logger-init';

initLogger()
  .then(() => {
    const logger = getLogger();
    logger.info('[app] starting markdawn web');
    logger.debug(`[env] NODE_ENV: ${import.meta.env.MODE}`);
    logger.debug(`[env] VITE_API_URL: ${import.meta.env.VITE_API_URL ?? 'not set'}`);
    logger.debug(`[env] VITE_COLLAB_URL: ${import.meta.env.VITE_COLLAB_URL ?? 'not set'}`);
  })
  .catch((err) => {
    console.error('[app] failed to initialize logger:', err);
  });

const theme = createTheme({
  colors: {
    success: [
      '#fafafa',
      '#f4f4f5',
      '#e4e4e7',
      '#d4d4d8',
      '#a1a1aa',
      '#71717a',
      '#52525b',
      '#3f3f46',
      '#27272a',
      '#18181b',
    ],
    error: [
      '#fafafa',
      '#f4f4f5',
      '#e4e4e7',
      '#d4d4d8',
      '#a1a1aa',
      '#71717a',
      '#52525b',
      '#3f3f46',
      '#27272a',
      '#18181b',
    ],
    info: [
      '#fafafa',
      '#f4f4f5',
      '#e4e4e7',
      '#d4d4d8',
      '#a1a1aa',
      '#71717a',
      '#52525b',
      '#3f3f46',
      '#27272a',
      '#18181b',
    ],
  },
  primaryColor: 'success',
  components: {
    Notification: {
      styles: (theme: MantineTheme) => ({
        root: {
          backgroundColor: 'var(--color-surface-elevated)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text)',
          width: 'fit-content',
          minWidth: '240px',
          maxWidth: '420px',
          marginLeft: 'auto',
          marginRight: 'auto',
        },
        title: {
          color: 'var(--color-text)',
        },
        description: {
          color: 'var(--color-text-muted)',
        },
      }),
    },
  },
});

const queryClient = new QueryClient();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <MantineProvider theme={theme}>
      <Notifications position="top-center" transitionDuration={300} />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
