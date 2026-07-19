import { describe, expect, it } from 'vitest';
import { normalizeWikiLinkLookupKey } from './wikiLink';

describe('normalizeWikiLinkLookupKey', () => {
  it.each([
    ['Roadmap', 'roadmap'],
    ['/Roadmap.md#Plan', 'roadmap'],
    ['./Folder/Roadmap.MD', 'folder/roadmap'],
    ['Folder\\Roadmap#Plan', 'folder/roadmap'],
    ['  Mixed Case  ', 'mixed case'],
  ])('normalizes %s consistently', (input, expected) => {
    expect(normalizeWikiLinkLookupKey(input)).toBe(expected);
  });
});
