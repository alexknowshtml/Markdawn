import {
  type CapabilitySet,
  deriveCapabilities,
  getAnonymousName,
  type PublicPermission,
} from '@markdawn/shared';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { getAnonymousId } from '../utils/anonymous-cookie';

export type AccessPermission = PublicPermission | null;

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
  publicPermission?: AccessPermission;
  pages?: PublicFolderPage[];
  folders?: PublicFolderPayload[];
};

interface ShareContextType {
  isAnonymous: boolean;
  anonymousId: string | null;
  anonymousName: string | null;
  accessPermission: AccessPermission;
  capabilities: CapabilitySet;
  publicEntity: PublicFolderPayload | null;
  /** @deprecated Use capabilities.canEdit instead */
  canEdit: boolean;
}

const ShareContext = createContext<ShareContextType | undefined>(undefined);
const SetAccessPermissionContext = createContext<
  React.Dispatch<React.SetStateAction<AccessPermission>>
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
  publicPermission?: AccessPermission;
  capabilities?: CapabilitySet;
  publicEntity?: PublicFolderPayload | null;
}

export function ShareProvider({
  children,
  publicPermission: initial = null,
  capabilities: initialCapabilities,
  publicEntity = null,
}: ShareProviderProps) {
  const { data: session } = useAuth();
  const isAnonymous = !session?.user;
  const [accessPermission, setAccessPermission] = useState(initial);
  // Default to no capabilities while loading to prevent flash of editable content
  const [capabilities, setCapabilities] = useState<CapabilitySet>(
    initialCapabilities ?? DEFAULT_CAPABILITIES,
  );

  useEffect(() => {
    setAccessPermission(initial);
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
        accessPermission,
        capabilities,
        publicEntity,
        canEdit: capabilities.canEdit,
      };
    }

    const anonymousId = getAnonymousId();
    const anonymousName = getAnonymousName(anonymousId);
    const anonymousCapabilities = deriveCapabilities(accessPermission);

    return {
      isAnonymous: true,
      anonymousId,
      anonymousName,
      accessPermission,
      capabilities: anonymousCapabilities,
      publicEntity,
      canEdit: anonymousCapabilities.canEdit,
    };
  }, [isAnonymous, accessPermission, capabilities, publicEntity]);

  return (
    <SetCapabilitiesContext.Provider value={setCapabilities}>
      <SetAccessPermissionContext.Provider value={setAccessPermission}>
        <ShareContext.Provider value={value}>{children}</ShareContext.Provider>
      </SetAccessPermissionContext.Provider>
    </SetCapabilitiesContext.Provider>
  );
}

const DEFAULT_SHARE_CONTEXT: ShareContextType = {
  isAnonymous: false,
  anonymousId: null,
  anonymousName: null,
  accessPermission: null,
  capabilities: DEFAULT_CAPABILITIES,
  publicEntity: null,
  canEdit: false,
};

export function useShareContext(): ShareContextType {
  const context = useContext(ShareContext);
  return context ?? DEFAULT_SHARE_CONTEXT;
}

export function useSetAccessPermission(): React.Dispatch<React.SetStateAction<AccessPermission>> {
  return useContext(SetAccessPermissionContext);
}

export function useSetCapabilities(): React.Dispatch<React.SetStateAction<CapabilitySet>> {
  return useContext(SetCapabilitiesContext);
}
