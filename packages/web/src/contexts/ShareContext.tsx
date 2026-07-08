import { type CapabilitySet, deriveCapabilities, getAnonymousName } from '@markdawn/shared';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getAnonymousId } from '../utils/anonymous-cookie';

export type LinkPermission = 'view' | 'edit' | null;

export type PublicFolderPage = {
  id: string;
  parent_id?: string | null;
  parentId?: string | null;
  title: string;
  icon?: string | null;
  created_by?: string | null;
  createdBy?: string | null;
  owner_id?: string | null;
  ownerId?: string | null;
  created_at?: string | Date | null;
  createdAt?: string | Date | null;
  updated_at?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type PublicFolderPayload = {
  id: string;
  parentId?: string | null;
  name: string;
  icon?: string | null;
  position?: string | null;
  createdBy?: string | null;
  owner_id?: string | null;
  ownerId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  isPublic?: boolean;
  linkPermission?: LinkPermission;
  pages?: PublicFolderPage[];
  folders?: PublicFolderPayload[];
};

interface ShareContextType {
  isAnonymous: boolean;
  anonymousId: string | null;
  anonymousName: string | null;
  linkPermission: LinkPermission;
  capabilities: CapabilitySet;
  publicEntity: PublicFolderPayload | null;
  /** @deprecated Use capabilities.canEdit instead */
  canEdit: boolean;
}

const ShareContext = createContext<ShareContextType | undefined>(undefined);
const SetLinkPermissionContext = createContext<
  React.Dispatch<React.SetStateAction<LinkPermission>>
>(() => {});
const SetCapabilitiesContext = createContext<React.Dispatch<React.SetStateAction<CapabilitySet>>>(
  () => {},
);

const DEFAULT_CAPABILITIES: CapabilitySet = {
  canEdit: false,
  canComment: false,
  canDelete: false,
  canCopy: false,
};

interface ShareProviderProps {
  children: ReactNode;
  linkPermission?: LinkPermission;
  capabilities?: CapabilitySet;
  publicEntity?: PublicFolderPayload | null;
}

export function ShareProvider({
  children,
  linkPermission: initial = null,
  capabilities: initialCapabilities,
  publicEntity = null,
}: ShareProviderProps) {
  const { data: session } = useAuth();
  const isAnonymous = !session?.user;
  const [linkPermission, setLinkPermission] = useState(initial);
  // Default to no capabilities while loading to prevent flash of editable content
  const [capabilities, setCapabilities] = useState<CapabilitySet>(
    initialCapabilities ?? DEFAULT_CAPABILITIES,
  );

  useEffect(() => {
    setLinkPermission(initial);
  }, [initial]);

  useEffect(() => {
    if (initialCapabilities) {
      setCapabilities(initialCapabilities);
    }
  }, [initialCapabilities]);

  const value = useMemo(() => {
    if (!isAnonymous) {
      return {
        isAnonymous: false,
        anonymousId: null,
        anonymousName: null,
        linkPermission,
        capabilities,
        publicEntity,
        canEdit: capabilities.canEdit,
      };
    }

    const anonymousId = getAnonymousId();
    const anonymousName = getAnonymousName(anonymousId);
    // For anonymous users, derive capabilities from the link permission
    const anonCapabilities = deriveCapabilities(
      linkPermission === 'edit' ? 'edit' : linkPermission === 'view' ? 'view' : null,
    );

    return {
      isAnonymous: true,
      anonymousId,
      anonymousName,
      linkPermission,
      capabilities: anonCapabilities,
      publicEntity,
      canEdit: anonCapabilities.canEdit,
    };
  }, [isAnonymous, linkPermission, capabilities, publicEntity]);

  return (
    <SetCapabilitiesContext.Provider value={setCapabilities}>
      <SetLinkPermissionContext.Provider value={setLinkPermission}>
        <ShareContext.Provider value={value}>{children}</ShareContext.Provider>
      </SetLinkPermissionContext.Provider>
    </SetCapabilitiesContext.Provider>
  );
}

const DEFAULT_SHARE_CONTEXT: ShareContextType = {
  isAnonymous: false,
  anonymousId: null,
  anonymousName: null,
  linkPermission: null,
  capabilities: DEFAULT_CAPABILITIES,
  publicEntity: null,
  canEdit: false,
};

export function useShareContext(): ShareContextType {
  const context = useContext(ShareContext);
  return context ?? DEFAULT_SHARE_CONTEXT;
}

export function useSetLinkPermission(): React.Dispatch<React.SetStateAction<LinkPermission>> {
  return useContext(SetLinkPermissionContext);
}

export function useSetCapabilities(): React.Dispatch<React.SetStateAction<CapabilitySet>> {
  return useContext(SetCapabilitiesContext);
}
