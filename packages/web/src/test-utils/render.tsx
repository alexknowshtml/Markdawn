import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderOptions, type RenderResult, render as rtlRender } from '@testing-library/react';
import type React from 'react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { KeyboardShortcutProvider } from '../contexts/KeyboardShortcutContext';
import { createQueryClient } from '../lib/query-client';

export function createTestQueryClient(): QueryClient {
  return createQueryClient({
    queries: {
      retry: false,
      gcTime: Number.POSITIVE_INFINITY,
    },
    mutations: {
      retry: false,
    },
  });
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  queryClient?: QueryClient;
}

export function render(
  ui: ReactElement,
  options: CustomRenderOptions = {},
): { queryClient: QueryClient } & RenderResult {
  const { route = '/', queryClient = createTestQueryClient(), ...renderOptions } = options;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <KeyboardShortcutProvider>{children}</KeyboardShortcutProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    ...rtlRender(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

export { createTestQueryClient as createQueryClient };
