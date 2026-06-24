import { type DefaultOptions, MutationCache, QueryClient } from '@tanstack/react-query';
import { getLogger } from '../logger-init';
import { showErrorToast } from '../utils/toast';

function handleMutationError(
  error: Error,
  _variables: unknown,
  _context: unknown,
  mutation: unknown,
): void {
  const meta = (mutation as { meta?: Record<string, unknown> }).meta;
  const message =
    (meta?.errorMessage as string | undefined) ?? error.message ?? 'An unexpected error occurred';

  try {
    getLogger().error('Mutation failed', {
      error: error.message,
      meta,
      mutationKey: (mutation as { options?: { mutationKey?: unknown } }).options?.mutationKey,
    });
  } catch {
    // Logger not available outside of initialized context (e.g., tests)
  }

  showErrorToast(message);
}

export function createQueryClient(defaultOptions?: DefaultOptions): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: handleMutationError,
    }),
    ...(defaultOptions ? { defaultOptions } : {}),
  });
}
