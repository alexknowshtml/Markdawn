import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { getAnonymousName } from '@markdawn/shared';
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

export function useShareContext() {
  const context = useContext(ShareContext);
  if (context === undefined) {
    throw new Error('useShareContext must be used within a ShareProvider');
  }
  return context;
}
