export const getExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
};

const ALLOWED_IMAGE_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp', 'svg']);

export const isImageFile = (filename: string): boolean => {
  return ALLOWED_IMAGE_TYPES.has(getExtension(filename));
};

export const isMarkdownFile = (filename: string): boolean => {
  return filename.endsWith('.md');
};

export const parseFrontmatter = (
  content: string,
): { frontmatter: Record<string, unknown>; body: string; tags: string[]; title: string } => {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    const title = h1Match?.[1]?.trim() ?? '';
    return { frontmatter: {}, body: content, tags: [], title };
  }

  const frontmatterBlock = match[1] ?? '';
  const body = content.slice(match[0]?.length);

  const frontmatter: Record<string, unknown> = {};
  const lines = frontmatterBlock.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] = [];
  let inArray = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      if (inArray && currentKey) {
        currentArray.push(
          trimmed
            .slice(2)
            .trim()
            .replace(/^["']|["']$/g, ''),
        );
      }
      continue;
    }

    if (inArray && currentKey) {
      frontmatter[currentKey] = currentArray;
      inArray = false;
      currentArray = [];
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value === '' || value === '[]') {
        inArray = true;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[currentKey] = value
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''));
      } else {
        frontmatter[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (inArray && currentKey) {
    frontmatter[currentKey] = currentArray;
  }

  let title = '';
  const titleValue = frontmatter.title;
  if (typeof titleValue === 'string') {
    title = titleValue;
  }

  const tags: string[] = [];
  const tagValue = frontmatter.tags;
  if (Array.isArray(tagValue)) {
    tags.push(...tagValue.filter((t): t is string => typeof t === 'string'));
  } else if (typeof tagValue === 'string') {
    tags.push(
      ...tagValue
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }

  return { frontmatter, body, tags, title };
};
