import { getAnonymousName } from '@markdawn/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getOrCreateAnonymousId } from '../utils/anonymous-cookie';

export type LinkPermission = 'view' | 'edit' | null;

interface ShareContextType {
  isAnonymous: boolean;
  anonymousId: string | null;
  anonymousName: string | null;
  linkPermission: LinkPermission;
  canEdit: boolean;
}

const ShareContext = createContext<ShareContextType | undefined>(undefined);

interface ShareProviderProps {
  children: ReactNode;
  linkPermission?: LinkPermission;
}

export function ShareProvider({ children, linkPermission = null }: ShareProviderProps) {
  const { data: session } = useAuth();
  const isAnonymous = !session?.user;

  const value = useMemo(() => {
    if (!isAnonymous) {
      return {
        isAnonymous: false,
        anonymousId: null,
        anonymousName: null,
        linkPermission,
        canEdit: true,
      };
    }

    const anonymousId = getOrCreateAnonymousId();
    const anonymousName = getAnonymousName(anonymousId);

    return {
      isAnonymous: true,
      anonymousId,
      anonymousName,
      linkPermission,
      canEdit: linkPermission === 'edit',
    };
  }, [isAnonymous, linkPermission]);

  return <ShareContext.Provider value={value}>{children}</ShareContext.Provider>;
}

const DEFAULT_SHARE_CONTEXT: ShareContextType = {
  isAnonymous: false,
  anonymousId: null,
  anonymousName: null,
  linkPermission: null,
  canEdit: true,
};

export function useShareContext(): ShareContextType {
  const context = useContext(ShareContext);
  return context ?? DEFAULT_SHARE_CONTEXT;
}
