import { authClient } from '../lib/auth-client';
import { getAnonymousId } from './anonymous-cookie';

type CollaborationIdentity = {
  isAnonymous: boolean;
  currentUserId: string | null;
};

export class CollaborationTokenRuntime {
  private identity: CollaborationIdentity;
  private cachedToken: { token: string; userId: string; expiresAt: number } | null = null;

  constructor(
    identity: CollaborationIdentity,
    private readonly isActive: () => boolean,
  ) {
    this.identity = identity;
  }

  updateIdentity(identity: CollaborationIdentity): void {
    const previousKey = this.identity.isAnonymous ? 'anonymous' : this.identity.currentUserId;
    const nextKey = identity.isAnonymous ? 'anonymous' : identity.currentUserId;
    this.identity = identity;
    if (previousKey !== nextKey) this.cachedToken = null;
  }

  readonly getToken = async (): Promise<string> => {
    if (!this.isActive()) throw new Error('Collaboration identity is no longer active');
    if (this.identity.isAnonymous) return `anon:${getAnonymousId()}`;

    const expectedUserId = this.identity.currentUserId;
    const cached = this.cachedToken;
    if (expectedUserId && cached?.userId === expectedUserId && Date.now() < cached.expiresAt) {
      return cached.token;
    }

    const session = await authClient.getSession();
    if (!this.isActive()) throw new Error('Collaboration identity is no longer active');
    const token = session.data?.session?.token ?? '';
    const userId = session.data?.user?.id ?? '';
    if (!token || !userId || !expectedUserId || userId !== expectedUserId) {
      this.cachedToken = null;
      throw new Error('Authenticated collaboration session changed or is unavailable');
    }
    this.cachedToken = { token, userId, expiresAt: Date.now() + 5 * 60 * 1000 };
    return token;
  };
}
