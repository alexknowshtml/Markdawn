const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractUuidFromSlug(slug: string): string | undefined {
  const uuidMatch = slug.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  const candidate = uuidMatch?.[1];
  return candidate && UUID_REGEX.test(candidate) ? candidate : undefined;
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildPagePath(title: string, pageId: string): string {
  const slug = slugifyTitle(title) || 'page';
  return `/app/${slug}-${pageId}`;
}

export function buildFolderPath(name: string, folderId: string): string {
  const slug = slugifyTitle(name) || 'folder';
  return `/app/folder/${slug}-${folderId}`;
}

export function buildEntityPath(
  entityType: 'page' | 'folder',
  title: string,
  entityId: string,
): string {
  return entityType === 'folder'
    ? buildFolderPath(title, entityId)
    : buildPagePath(title, entityId);
}

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'fax']);
const URL_SCHEME_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

/**
 * Normalizes links entered in the editor and rejects executable or otherwise
 * unsupported URL schemes. An empty result must never be opened or persisted.
 */
export function ensureAbsoluteUrl(url: string): string {
  if (!url) return url;

  const trimmed = url.trim();
  if (!trimmed || hasControlCharacter(trimmed)) return '';

  // A bare host with a numeric port resembles a URL scheme but should still
  // receive the default HTTPS protocol.
  if (/^[^/?#:]+\.[^/?#:]+:\d+(?:[/?#]|$)/.test(trimmed)) {
    return `https://${trimmed}`;
  }

  const scheme = trimmed.match(URL_SCHEME_REGEX)?.[1]?.toLowerCase();
  if (scheme) {
    return SAFE_LINK_SCHEMES.has(scheme) ? trimmed : '';
  }

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
