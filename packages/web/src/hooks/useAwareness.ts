import type { HocuspocusProvider } from '@hocuspocus/provider';
import { getStableColor } from '@markdawn/shared';
import { useEffect } from 'react';
import { useAuth } from './useAuth';

export function useAwareness(provider: HocuspocusProvider | null) {
  const { data: session } = useAuth();

  useEffect(() => {
    if (!provider || !provider.awareness || !session?.user) return;

    const userColor = getStableColor(session.user.id);
    provider.awareness.setLocalStateField('user', {
      name: session.user.name || 'Anonymous',
      color: userColor,
      avatar: session.user.image,
    });

    return () => {
      provider.awareness?.setLocalStateField('user', null);
    };
  }, [provider, session]);
}
