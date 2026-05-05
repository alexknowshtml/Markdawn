import { describe, expect, it } from 'vitest';
import { getExtension, isImageFile, isMarkdownFile, parseFrontmatter } from './obsidian-parsers';

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
