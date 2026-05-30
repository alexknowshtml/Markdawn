const COOKIE_NAME = 'markdawn_anon_id';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function setCookie(name: string, value: string, maxAge: number): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not widely supported
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

let cachedId: string | null = null;

export function getAnonymousId(): string {
  if (cachedId) return cachedId;

  const existing = getCookie(COOKIE_NAME);
  if (existing) {
    cachedId = existing;
    return cachedId;
  }

  const id = crypto.randomUUID();
  setCookie(COOKIE_NAME, id, ONE_YEAR_SECONDS);
  cachedId = id;
  return cachedId;
}
