const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractUuidFromSlug(slug: string): string | undefined {
  const uuidMatch = slug.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  const candidate = uuidMatch?.[1];
  return candidate && UUID_REGEX.test(candidate) ? candidate : undefined;
}

export function ensureAbsoluteUrl(url: string): string {
  if (!url) return url;

  const trimmed = url.trim();

  // Already has :// scheme (http://, https://, ftp://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmed)) return trimmed;

  // Known schemes without :// (mailto:, tel:, etc.)
  if (/^(mailto|tel|sms|fax):/i.test(trimmed)) return trimmed;

  // Common protocol-like prefix (javascript:, data:) — leave untouched
  if (/^(javascript|data|blob):/i.test(trimmed)) return trimmed;

  // Leading slash, hash, question mark, or dot → relative/internal
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('.')
  )
    return trimmed;

  // Bare domain — dot must appear before any slash so "docs/file.md"
  // is left alone while "samvaad.live" and "samvaad.live/page" get https://
  const slashIndex = trimmed.indexOf('/');
  const dotBeforeSlash =
    slashIndex === -1 ? trimmed.includes('.') : trimmed.slice(0, slashIndex).includes('.');

  if (dotBeforeSlash) return `https://${trimmed}`;

  return trimmed;
}
