import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
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

export function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}
