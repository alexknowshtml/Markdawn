export function getDbHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function parseCookies(cookieHeader?: string): Map<string, string> {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  const cookies = new Map<string, string>();
  for (const cookie of cookieHeader.split(';')) {
    const [rawKey, ...rawValueParts] = cookie.split('=');
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }

    const value = rawValueParts.join('=').trim();
    if (!value) {
      continue;
    }

    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }

  return cookies;
}
