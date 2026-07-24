import { useCallback, useMemo } from 'react';
import { cleanTagName, tagIdentity } from '../utils/tags';
import { usePages } from './use-pages';
import { useTags } from './use-tags';

const DEFAULT_PROPERTY_KEYS = ['tags', 'date', 'author', 'url', 'created', 'updated'];

export function usePropertyMetadata() {
  const { data: pages = [] } = usePages();
  const { data: indexedTags, refetch: refetchIndexedTags } = useTags();
  const refreshTags = useCallback(() => {
    void refetchIndexedTags();
  }, [refetchIndexedTags]);

  return useMemo(() => {
    const keys = new Set(DEFAULT_PROPERTY_KEYS);
    const tags = new Map<string, string>();
    const addTag = (value: string) => {
      const name = cleanTagName(value);
      const identity = tagIdentity(name);
      if (identity && !tags.has(identity)) tags.set(identity, name);
    };

    for (const page of pages) {
      if (!page.properties || typeof page.properties !== 'object') continue;

      for (const [key, value] of Object.entries(page.properties)) {
        keys.add(key);
        if (key.toLowerCase() !== 'tags' && key.toLowerCase() !== 'tag') continue;

        const values = Array.isArray(value) ? value : [value];
        for (const candidate of values) {
          if (typeof candidate !== 'string') continue;
          addTag(candidate);
        }
      }
    }

    for (const indexedTag of indexedTags ?? []) addTag(indexedTag.name);

    return {
      allKeys: Array.from(keys).sort((a, b) => a.localeCompare(b)),
      allTags: Array.from(tags.values()).sort((a, b) => a.localeCompare(b)),
      refreshTags,
    };
  }, [indexedTags, pages, refreshTags]);
}
