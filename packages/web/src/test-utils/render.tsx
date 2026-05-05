import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderOptions, type RenderResult, render as rtlRender } from '@testing-library/react';
import type React from 'react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

const testTheme = createTheme({
  components: {
    Modal: {
      defaultProps: {
        transitionProps: { duration: 0 },
      },
    },
    Drawer: {
      defaultProps: {
        transitionProps: { duration: 0 },
      },
    },
    Popover: {
      defaultProps: {
        transitionProps: { duration: 0 },
      },
    },
  },
});

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Number.POSITIVE_INFINITY,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  queryClient?: QueryClient;
}

export function render(ui: ReactElement, options: CustomRenderOptions = {}): { queryClient: QueryClient } & RenderResult {
  const { route = '/', queryClient = createTestQueryClient(), ...renderOptions } = options;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MantineProvider theme={testTheme}>
          <Notifications />
          <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
        </MantineProvider>
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    ...rtlRender(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

export { createTestQueryClient as createQueryClient };
