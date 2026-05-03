import { authClient } from '../lib/auth-client';

export const useAuth = () => authClient.useSession();
