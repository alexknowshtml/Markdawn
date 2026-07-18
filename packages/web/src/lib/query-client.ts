import {
  type DefaultOptions,
  type Mutation,
  MutationCache,
  type MutationCacheNotifyEvent,
  type MutationFunctionContext,
  type MutationOptions,
  type MutationState,
  QueryClient,
} from '@tanstack/react-query';
import { getLogger } from '../logger-init';
import { showErrorToast } from '../utils/toast';

const retiredQueryClients = new WeakSet<QueryClient>();
const lifecycleMutationCaches = new WeakMap<QueryClient, LifecycleMutationCache>();
const guardedMutationOptions = new WeakSet<object>();

function guardMutationCallbacks<TData, TError, TVariables, TOnMutateResult>(
  options: MutationOptions<TData, TError, TVariables, TOnMutateResult>,
  isActive: () => boolean,
): MutationOptions<TData, TError, TVariables, TOnMutateResult> {
  // MutationObserver re-applies its options to a pending Mutation on every
  // render. Mark guarded objects so that neither that path nor build() nests
  // another set of wrappers around the same callbacks.
  if (guardedMutationOptions.has(options)) return options;

  const { mutationFn, onMutate, onSuccess, onError, onSettled } = options;

  const guardedOptions = {
    ...options,
    ...(mutationFn
      ? {
          mutationFn: (variables: TVariables, context: MutationFunctionContext) => {
            if (!isActive()) {
              return Promise.reject(new Error('Identity retired before mutation request'));
            }
            return mutationFn(variables, context);
          },
        }
      : {}),
    ...(onMutate
      ? {
          onMutate: (variables: TVariables, context: MutationFunctionContext) => {
            if (!isActive()) return undefined as TOnMutateResult;
            return onMutate(variables, context);
          },
        }
      : {}),
    ...(onSuccess
      ? {
          onSuccess: (
            data: TData,
            variables: TVariables,
            onMutateResult: TOnMutateResult,
            context: MutationFunctionContext,
          ) => {
            if (!isActive()) return;
            return onSuccess(data, variables, onMutateResult, context);
          },
        }
      : {}),
    ...(onError
      ? {
          onError: (
            error: TError,
            variables: TVariables,
            onMutateResult: TOnMutateResult | undefined,
            context: MutationFunctionContext,
          ) => {
            if (!isActive()) return;
            return onError(error, variables, onMutateResult, context);
          },
        }
      : {}),
    ...(onSettled
      ? {
          onSettled: (
            data: TData | undefined,
            error: TError | null,
            variables: TVariables,
            onMutateResult: TOnMutateResult | undefined,
            context: MutationFunctionContext,
          ) => {
            if (!isActive()) return;
            return onSettled(data, error, variables, onMutateResult, context);
          },
        }
      : {}),
  };
  guardedMutationOptions.add(guardedOptions);
  return guardedOptions;
}

class LifecycleMutationCache extends MutationCache {
  private active = true;

  constructor() {
    super({ onError: handleMutationError });
  }

  retire(): void {
    this.active = false;
  }

  override notify(event: MutationCacheNotifyEvent): void {
    // MutationObserver.setOptions() otherwise replaces the callbacks guarded
    // in build() whenever a pending hook renders. Guard the observer options
    // synchronously before it copies them back onto the active Mutation.
    if (event.type === 'observerOptionsUpdated') {
      event.observer.options = guardMutationCallbacks(event.observer.options, () => this.active);
    }
    super.notify(event);
  }

  override build<TData, TError, TVariables, TOnMutateResult>(
    client: QueryClient,
    options: MutationOptions<TData, TError, TVariables, TOnMutateResult>,
    state?: MutationState<TData, TError, TVariables, TOnMutateResult>,
  ): Mutation<TData, TError, TVariables, TOnMutateResult> {
    const defaultedOptions = client.defaultMutationOptions(options);
    const guardedOptions = guardMutationCallbacks(defaultedOptions, () => this.active);
    return super.build(client, guardedOptions, state);
  }
}

function handleMutationError(
  error: Error,
  _variables: unknown,
  _context: unknown,
  mutation: unknown,
  mutationContext: MutationFunctionContext,
): void {
  // Clearing a QueryClient removes pending mutations from its cache, but it
  // does not cancel their underlying promises. A retired identity's mutation
  // can therefore still settle after another identity has mounted. Keep the
  // error local to the retired client instead of surfacing it to the new user.
  if (retiredQueryClients.has(mutationContext.client)) return;

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
  const mutationCache = new LifecycleMutationCache();
  const queryClient = new QueryClient({
    mutationCache,
    ...(defaultOptions ? { defaultOptions } : {}),
  });
  lifecycleMutationCaches.set(queryClient, mutationCache);
  return queryClient;
}

export function retireQueryClient(queryClient: QueryClient): void {
  retiredQueryClients.add(queryClient);
  lifecycleMutationCaches.get(queryClient)?.retire();
  queryClient.clear();
}
