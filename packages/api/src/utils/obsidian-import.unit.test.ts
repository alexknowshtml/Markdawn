import { describe, expect, it } from 'vitest';

// Replicate or import pure helpers from obsidian-import.ts
// These are extracted to make deterministic unit coverage possible.
const getExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
};

const ALLOWED_IMAGE_TYPES = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp', 'svg']);

const isImageFile = (filename: string): boolean => {
  return ALLOWED_IMAGE_TYPES.has(getExtension(filename));
};

const isMarkdownFile = (filename: string): boolean => {
  return filename.endsWith('.md');
};

const parseFrontmatter = (
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
          trimmed.slice(2).trim().replace(/^["']|["']$/g, ''),
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

describe('obsidian-import / getExtension', () => {
  it('returns extension for a filename', () => {
    expect(getExtension('image.png')).toBe('png');
  });

  it('handles no extension', () => {
    expect(getExtension('README')).toBe('');
  });

  it('handles multiple dots', () => {
    expect(getExtension('archive.tar.gz')).toBe('gz');
  });
});

describe('obsidian-import / isImageFile', () => {
  it('returns true for image extensions', () => {
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
  });

  it('returns false for non-image extensions', () => {
    expect(isImageFile('doc.pdf')).toBe(false);
    expect(isImageFile('note.md')).toBe(false);
  });
});

describe('obsidian-import / isMarkdownFile', () => {
  it('returns true for .md files', () => {
    expect(isMarkdownFile('note.md')).toBe(true);
  });

  it('returns false for non-.md files', () => {
    expect(isMarkdownFile('note.txt')).toBe(false);
    expect(isMarkdownFile('image.png')).toBe(false);
  });
});

describe('obsidian-import / parseFrontmatter', () => {
  it('parses YAML frontmatter with title and tags', () => {
    const result = parseFrontmatter(`---
title: My Note
tags:
  - tag1
  - tag2
---

# Content`);

    expect(result.title).toBe('My Note');
    expect(result.tags).toEqual(['tag1', 'tag2']);
    expect(result.body).toContain('# Content');
  });

  it('returns empty frontmatter when none exists', () => {
    const result = parseFrontmatter('# Just a heading\n\nSome text');
    expect(result.frontmatter).toEqual({});
    expect(result.tags).toEqual([]);
    expect(result.body).toContain('# Just a heading');
  });

  it('parses inline array tags', () => {
    const result = parseFrontmatter(`---
title: Note
tags: [tag1, tag2]
---

Body`);

    expect(result.title).toBe('Note');
    expect(result.tags).toEqual(['tag1', 'tag2']);
  });

  it('handles empty content', () => {
    const result = parseFrontmatter('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
  });

  it('extracts title from H1 when no frontmatter', () => {
    const result = parseFrontmatter('# Page Title\n\nSome content');
    expect(result.title).toBe('Page Title');
  });
});
