export const MAX_PAGE_TITLE_LENGTH = 250;

/** Match PostgreSQL char_length(): count Unicode code points, not UTF-16 units. */
export function getUnicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

/** Truncate on a Unicode code-point boundary without splitting surrogate pairs. */
export function truncateUnicodeCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}
