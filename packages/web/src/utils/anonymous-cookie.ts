const COOKIE_NAME = 'markdawn_anon_id';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

async function getCookie(name: string): Promise<string | undefined> {
  if ('cookieStore' in window) {
    const cookie = await window.cookieStore.get(name);
    return cookie?.value;
  }
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function setCookie(name: string, value: string, maxAge: number): Promise<void> {
  await window.cookieStore.set({
    name,
    value: encodeURIComponent(value),
    expires: Date.now() + maxAge * 1000,
    path: '/',
    sameSite: 'lax',
  });
}

export async function getOrCreateAnonymousId(): Promise<string> {
  const existing = await getCookie(COOKIE_NAME);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  await setCookie(COOKIE_NAME, id, ONE_YEAR_SECONDS);
  return id;
}
