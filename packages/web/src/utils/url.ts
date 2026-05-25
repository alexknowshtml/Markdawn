/**
 * If a URL string looks like a bare domain or IP-based address (has a dot
 * but no protocol), prepend `https://`. Everything else — relative paths,
 * anchors, protocol-prefixed URLs — passes through unchanged.
 */
export function ensureAbsoluteUrl(url: string): string {
  if (!url) return url;

  // Already has a protocol scheme (http://, https://, mailto:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(url)) return url;

  // Already relative or internal
  if (url.startsWith('/') || url.startsWith('#') || url.startsWith('?')) return url;

  // Has a dot → likely a domain name or IP
  if (url.includes('.')) return `https://${url}`;

  return url;
}
