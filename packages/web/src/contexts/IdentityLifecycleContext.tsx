import { createContext, type ReactNode, useCallback, useContext } from 'react';
import {
  type NavigateFunction,
  type NavigateOptions,
  type To,
  useNavigate,
} from 'react-router-dom';

export type IdentityLifecycle = {
  isActive: () => boolean;
  retire: () => void;
};

const alwaysActiveLifecycle: IdentityLifecycle = {
  isActive: () => true,
  retire: () => undefined,
};

const IdentityLifecycleContext = createContext<IdentityLifecycle>(alwaysActiveLifecycle);

export function createIdentityLifecycle(): IdentityLifecycle {
  let active = true;
  return {
    isActive: () => active,
    retire: () => {
      active = false;
    },
  };
}

export function IdentityLifecycleProvider({
  lifecycle,
  children,
}: {
  lifecycle: IdentityLifecycle;
  children?: ReactNode;
}) {
  return (
    <IdentityLifecycleContext.Provider value={lifecycle}>
      {children}
    </IdentityLifecycleContext.Provider>
  );
}

export function useIdentityLifecycle(): IdentityLifecycle {
  return useContext(IdentityLifecycleContext);
}

/** A NavigateFunction captured by one identity becomes inert once it retires. */
export function useIdentityNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const lifecycle = useIdentityLifecycle();

  return useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (!lifecycle.isActive()) return;
      if (typeof to === 'number') return navigate(to);
      if (options === undefined) return navigate(to);
      return navigate(to, options);
    }) as NavigateFunction,
    [lifecycle, navigate],
  );
}
