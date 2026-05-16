import { useMemo } from 'react';
import { usePages } from './use-pages';

export function useWorkspaceMetadata(workspaceId: string) {
  const { data: pages = [] } = usePages(workspaceId);

  return useMemo(() => {
    const keys = new Set<string>();
    const tags = new Set<string>();

    for (const page of pages) {
      const props = page.properties;
      if (props && typeof props === 'object') {
        for (const [key, value] of Object.entries(props)) {
          keys.add(key);
          if (key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag') {
            if (Array.isArray(value)) {
              for (const v of value) {
                if (typeof v === 'string' && v.trim()) tags.add(v.trim());
              }
            } else if (typeof value === 'string' && value.trim()) {
              tags.add(value.trim());
            }
          }
        }
      }
    }

    // Default keys to suggest even if workspace is empty
    const defaultKeys = ['tags', 'date', 'author', 'url', 'created', 'updated'];
    for (const k of defaultKeys) keys.add(k);

    return {
      allKeys: Array.from(keys).sort(),
      allTags: Array.from(tags).sort(),
    };
  }, [pages]);
}
