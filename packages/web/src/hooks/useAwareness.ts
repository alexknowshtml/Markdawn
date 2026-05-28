import type { HocuspocusProvider } from '@hocuspocus/provider';
import { getStableColor } from '@markdawn/shared';
import { useEffect } from 'react';
import { useShareContext } from '../contexts/ShareContext';
import { useAuth } from './useAuth';

export function useAwareness(provider: HocuspocusProvider | null) {
  const { data: session } = useAuth();
  const { isAnonymous, anonymousId, anonymousName } = useShareContext();

  useEffect(() => {
    if (!provider?.awareness) return;

    if (isAnonymous && anonymousId) {
      const userColor = getStableColor(anonymousId);
      provider.awareness.setLocalStateField('user', {
        name: anonymousName || 'Anonymous',
        color: userColor,
        avatar: null,
        isAnonymous: true,
      });
    } else if (session?.user) {
      const userColor = getStableColor(session.user.id);
      provider.awareness.setLocalStateField('user', {
        name: session.user.name || 'Anonymous',
        color: userColor,
        avatar: session.user.image,
      });
    }

    return () => {
      provider.awareness?.setLocalStateField('user', null);
    };
  }, [provider, session, isAnonymous, anonymousId, anonymousName]);
}
