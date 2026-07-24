/** Matches Milkdown's default heading ID generator. */
export function getMilkdownHeadingId(heading: string): string {
  return heading.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Prefer the actual rendered ID, then find headings whose text would produce
 * the requested default Milkdown ID. The fallback also supports headings with
 * explicit custom IDs.
 */
export function findRenderedHeading(
  editorElement: HTMLElement,
  requestedId: string,
): HTMLElement | null {
  const headings = editorElement.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  for (const heading of headings) {
    if (heading.id === requestedId) return heading;
  }
  for (const heading of headings) {
    if (getMilkdownHeadingId(heading.textContent ?? '') === requestedId) return heading;
  }
  return null;
}
