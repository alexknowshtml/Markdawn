/**
 * Canonical lookup key for authored wiki-link paths.
 *
 * Obsidian-style paths may use Windows separators, a leading relative/root
 * marker, an optional Markdown suffix, and a heading suffix. Every producer
 * and resolver must use this exact function so the trusted target does not
 * change during a connection-index rebuild.
 */
export function normalizeWikiLinkLookupKey(value: string): string {
  const path = value.split('#')[0] ?? '';
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}
