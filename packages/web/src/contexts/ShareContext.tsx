import { getAnonymousName } from '@markdawn/shared';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
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
  const [anonymousId, setAnonymousId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAnonymous) {
      setAnonymousId(null);
      return;
    }
    void getOrCreateAnonymousId().then(setAnonymousId);
  }, [isAnonymous]);

  const anonymousName = anonymousId ? getAnonymousName(anonymousId) : null;

  const value: ShareContextType = {
    isAnonymous,
    anonymousId,
    anonymousName,
    linkPermission,
    canEdit: isAnonymous ? linkPermission === 'edit' : true,
  };

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
