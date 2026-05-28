const COOKIE_NAME = 'markdawn_anon_id';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!match?.[1]) {
    return undefined;
  }
  return decodeURIComponent(match[1]);
}

function setCookie(name: string, value: string, maxAge: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

export function getOrCreateAnonymousId(): string {
  const existing = getCookie(COOKIE_NAME);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  setCookie(COOKIE_NAME, id, ONE_YEAR_SECONDS);
  return id;
}
