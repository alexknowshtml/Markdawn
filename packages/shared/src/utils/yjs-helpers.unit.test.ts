import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extractConnectionsFromYDoc, yDocToMarkdown } from './yjs-helpers';

// --------------------------------------------------------------------------
// Helpers for building Yjs test documents
// --------------------------------------------------------------------------

function encodeFragment(children: Y.XmlElement[]): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prosemirror');
  fragment.push(children);
  return Y.encodeStateAsUpdate(doc);
}

function block(name: string, children: (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const node = new Y.XmlElement(name);
  node.push(children);
  return node;
}

function blockWithAttrs(
  name: string,
  attrs: Record<string, string>,
  children: (Y.XmlElement | Y.XmlText)[],
): Y.XmlElement {
  const node = block(name, children);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
}

function inlineEl(name: string, attrs: Record<string, string>): Y.XmlElement {
  return blockWithAttrs(name, attrs, []);
}

function text(value: string): Y.XmlText {
  return new Y.XmlText(value);
}

function formattedText(value: string, formats: Record<string, unknown>): Y.XmlText {
  const t = new Y.XmlText(value);
  t.format(0, value.length, formats);
  return t;
}

// Marks use the y-prosemirror format (object values) since that's what the
// editor produces. The API import uses booleans but the serializer handles both.
const BOLD = { strong: {} };
const ITALIC = { emphasis: {} };
const CODE = { inlineCode: {} };
const STRIKE = { strike_through: {} };
const link = (href: string) => ({ link: { href, title: '' } });

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('yDocToMarkdown', () => {
  it('converts a plain paragraph', () => {
    const update = encodeFragment([block('paragraph', [text('Hello world')])]);
    expect(yDocToMarkdown(update)).toBe('Hello world\n\n');
  });

  it('converts a heading', () => {
    const update = encodeFragment([blockWithAttrs('heading', { level: '1' }, [text('Title')])]);
    expect(yDocToMarkdown(update)).toBe('# Title\n\n');
  });

  it('converts all heading levels', () => {
    for (let level = 1; level <= 6; level++) {
      const update = encodeFragment([
        blockWithAttrs('heading', { level: String(level) }, [text(`H${level}`)]),
      ]);
      expect(yDocToMarkdown(update)).toBe(`${'#'.repeat(level)} H${level}\n\n`);
    }
  });

  it('converts bold text', () => {
    const update = encodeFragment([block('paragraph', [formattedText('bold text', BOLD)])]);
    expect(yDocToMarkdown(update)).toBe('**bold text**\n\n');
  });

  it('converts italic text', () => {
    const update = encodeFragment([block('paragraph', [formattedText('italic text', ITALIC)])]);
    expect(yDocToMarkdown(update)).toBe('*italic text*\n\n');
  });

  it('converts strikethrough text', () => {
    const update = encodeFragment([block('paragraph', [formattedText('struck', STRIKE)])]);
    expect(yDocToMarkdown(update)).toBe('~~struck~~\n\n');
  });

  it('converts inline code', () => {
    const update = encodeFragment([block('paragraph', [formattedText('code', CODE)])]);
    expect(yDocToMarkdown(update)).toBe('`code`\n\n');
  });

  it('converts a link', () => {
    const update = encodeFragment([
      block('paragraph', [formattedText('click here', link('https://example.com'))]),
    ]);
    expect(yDocToMarkdown(update)).toBe('[click here](https://example.com)\n\n');
  });

  it('converts bold + italic combined', () => {
    // bold italic text
    const t = new Y.XmlText('bold and italic');
    t.format(0, 16, BOLD);
    t.format(5, 11, ITALIC); // "and italic" is also italic
    const update = encodeFragment([block('paragraph', [t])]);
    const result = yDocToMarkdown(update);
    // The exact output depends on delta segmentation but both marks must be present
    expect(result).toContain('**');
    expect(result).toContain('*');
  });

  it('converts a mix of plain and bold text', () => {
    const t1 = text('Plain ');
    const t2 = formattedText('bold', BOLD);
    const t3 = text(' text');
    const update = encodeFragment([block('paragraph', [t1, t2, t3])]);
    expect(yDocToMarkdown(update)).toBe('Plain **bold** text\n\n');
  });

  it('converts a link with bold inside', () => {
    const boldPart = formattedText('bold link', { ...BOLD, ...link('https://example.com') });
    const update = encodeFragment([block('paragraph', [boldPart])]);
    const result = yDocToMarkdown(update);
    // Should contain the URL and bold markers
    expect(result).toContain('https://example.com');
    expect(result).toContain('**');
    expect(result).toMatch(/\]\(https:\/\/example\.com\)/);
  });

  it('converts a code block without language', () => {
    const update = encodeFragment([blockWithAttrs('code_block', {}, [text('const x = 1;')])]);
    expect(yDocToMarkdown(update)).toBe('```\nconst x = 1;\n```\n\n');
  });

  it('converts a code block with language', () => {
    const update = encodeFragment([
      blockWithAttrs('code_block', { language: 'javascript' }, [text('const x = 1;')]),
    ]);
    expect(yDocToMarkdown(update)).toBe('```javascript\nconst x = 1;\n```\n\n');
  });

  it('converts a blockquote with single paragraph', () => {
    const update = encodeFragment([
      block('blockquote', [block('paragraph', [text('Cited text')])]),
    ]);
    expect(yDocToMarkdown(update)).toBe('> Cited text\n\n');
  });

  it('converts a blockquote with multiple paragraphs', () => {
    const update = encodeFragment([
      block('blockquote', [
        block('paragraph', [text('First para')]),
        block('paragraph', [text('Second para')]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('> First para\n>\n> Second para\n\n');
  });

  it('converts a bullet list', () => {
    const update = encodeFragment([
      block('bullet_list', [
        block('list_item', [block('paragraph', [text('Item A')])]),
        block('list_item', [block('paragraph', [text('Item B')])]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('- Item A\n- Item B\n');
  });

  it('converts an ordered list', () => {
    const update = encodeFragment([
      block('ordered_list', [
        block('list_item', [block('paragraph', [text('First')])]),
        block('list_item', [block('paragraph', [text('Second')])]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('1. First\n2. Second\n');
  });

  it('converts a task list (checked and unchecked)', () => {
    const update = encodeFragment([
      block('bullet_list', [
        blockWithAttrs('list_item', { checked: 'true' }, [block('paragraph', [text('Done')])]),
        blockWithAttrs('list_item', { checked: 'false' }, [block('paragraph', [text('Todo')])]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('- [x] Done\n- [ ] Todo\n');
  });

  it('converts a nested bullet list', () => {
    const update = encodeFragment([
      block('bullet_list', [
        block('list_item', [
          block('paragraph', [text('Top')]),
          block('bullet_list', [block('list_item', [block('paragraph', [text('Nested')])])]),
        ]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('- Top\n  - Nested\n');
  });

  it('converts a table', () => {
    const update = encodeFragment([
      block('table', [
        block('table_header_row', [
          blockWithAttrs('table_header', {}, [block('paragraph', [text('Name')])]),
          blockWithAttrs('table_header', {}, [block('paragraph', [text('Age')])]),
        ]),
        block('table_row', [
          blockWithAttrs('table_cell', {}, [block('paragraph', [text('Alice')])]),
          blockWithAttrs('table_cell', {}, [block('paragraph', [text('30')])]),
        ]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |\n\n');
  });

  it('converts a table with alignment', () => {
    const update = encodeFragment([
      block('table', [
        block('table_header_row', [
          blockWithAttrs('table_header', { alignment: 'left' }, [
            block('paragraph', [text('Left')]),
          ]),
          blockWithAttrs('table_header', { alignment: 'center' }, [
            block('paragraph', [text('Center')]),
          ]),
          blockWithAttrs('table_header', { alignment: 'right' }, [
            block('paragraph', [text('Right')]),
          ]),
        ]),
        block('table_row', [
          blockWithAttrs('table_cell', {}, [block('paragraph', [text('a')])]),
          blockWithAttrs('table_cell', {}, [block('paragraph', [text('b')])]),
          blockWithAttrs('table_cell', {}, [block('paragraph', [text('c')])]),
        ]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe(
      '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n\n',
    );
  });

  it('converts a wiki link without label', () => {
    const update = encodeFragment([
      block('paragraph', [inlineEl('wikiLink', { path: 'Page Name', label: 'Page Name' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('[[Page Name]]\n\n');
  });

  it('converts a wiki link with label', () => {
    const update = encodeFragment([
      block('paragraph', [inlineEl('wikiLink', { path: 'Long Page', label: 'Link' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('[[Long Page|Link]]\n\n');
  });

  it('converts a wiki link with heading', () => {
    const update = encodeFragment([
      block('paragraph', [
        inlineEl('wikiLink', { path: 'Page', heading: 'Section', label: 'Page#Section' }),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('[[Page#Section]]\n\n');
  });

  it('converts a wiki link with embedded heading in path (API import format)', () => {
    const update = encodeFragment([
      block('paragraph', [inlineEl('wikiLink', { path: 'Page#Section', label: 'Page#Section' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('[[Page#Section]]\n\n');
  });

  it('converts a tag (name attribute)', () => {
    const update = encodeFragment([
      block('paragraph', [text('Tag: '), inlineEl('tag', { name: 'project' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('Tag: #project\n\n');
  });

  it('converts a tag (value attribute — API import format)', () => {
    const update = encodeFragment([
      block('paragraph', [text('Tag: '), inlineEl('tag', { value: 'urgent' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('Tag: #urgent\n\n');
  });

  it('converts inline math', () => {
    const update = encodeFragment([
      block('paragraph', [text('Math: '), inlineEl('math_inline', { value: 'E=mc^2' })]),
    ]);
    expect(yDocToMarkdown(update)).toBe('Math: $E=mc^2$\n\n');
  });

  it('converts an image', () => {
    const update = encodeFragment([
      block('paragraph', [
        inlineEl('image', { src: 'https://example.com/pic.png', alt: 'Example', title: '' }),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('![Example](https://example.com/pic.png)\n\n');
  });

  it('converts an image with title', () => {
    const update = encodeFragment([
      block('paragraph', [
        inlineEl('image', {
          src: 'https://example.com/pic.png',
          alt: 'Example',
          title: 'A photo',
        }),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('![Example](https://example.com/pic.png "A photo")\n\n');
  });

  it('converts a horizontal rule', () => {
    const update = encodeFragment([block('hr', [])]);
    expect(yDocToMarkdown(update)).toBe('---\n\n');
  });

  it('converts a hard break', () => {
    const update = encodeFragment([
      block('paragraph', [text('Line 1'), block('hardbreak', []), text('Line 2')]),
    ]);
    const result = yDocToMarkdown(update);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  it('converts a callout', () => {
    const update = encodeFragment([
      blockWithAttrs('callout', { type: 'warning' }, [block('paragraph', [text('Be careful')])]),
    ]);
    expect(yDocToMarkdown(update)).toBe('> [!WARNING]\n> Be careful\n\n');
  });

  it('converts a callout with title', () => {
    const update = encodeFragment([
      blockWithAttrs('callout', { type: 'info', title: 'Note' }, [
        block('paragraph', [text('Something to note')]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('> [!INFO Note]\n> Something to note\n\n');
  });

  it('converts a multi-paragraph callout with empty lines between paragraphs', () => {
    const update = encodeFragment([
      blockWithAttrs('callout', { type: 'tip' }, [
        block('paragraph', [text('First para')]),
        block('paragraph', [text('Second para')]),
      ]),
    ]);
    expect(yDocToMarkdown(update)).toBe('> [!TIP]\n> First para\n>\n> Second para\n\n');
  });

  it('converts mixed content: heading + paragraph + list', () => {
    const update = encodeFragment([
      blockWithAttrs('heading', { level: '2' }, [text('Section')]),
      block('paragraph', [text('Some text with '), formattedText('emphasis', ITALIC)]),
      block('bullet_list', [
        block('list_item', [block('paragraph', [text('One')])]),
        block('list_item', [block('paragraph', [text('Two')])]),
      ]),
    ]);
    const md = yDocToMarkdown(update);
    expect(md).toContain('## Section');
    expect(md).toContain('Some text with *emphasis*');
    expect(md).toContain('- One\n- Two');
  });

  it('returns empty string for empty document', () => {
    const doc = new Y.Doc();
    const update = Y.encodeStateAsUpdate(doc);
    expect(yDocToMarkdown(update)).toBe('');
  });

  it('handles a document with only the prosemirror fragment and no children', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('prosemirror');
    const update = Y.encodeStateAsUpdate(doc);
    expect(yDocToMarkdown(update)).toBe('');
  });
});

describe('extractConnectionsFromYDoc', () => {
  it('extracts page and tag connections from Yjs documents', () => {
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('targetId', '11111111-1111-1111-1111-111111111111');
    link.setAttribute('path', 'Roadmap');
    link.setAttribute('label', 'Roadmap');

    const tag = new Y.XmlElement('tag');
    tag.setAttribute('name', 'Project');

    const update = encodeFragment([block('paragraph', [text('See '), link, text(' for '), tag])]);

    expect(extractConnectionsFromYDoc(update)).toEqual([
      {
        targetType: 'page',
        targetId: '11111111-1111-1111-1111-111111111111',
        targetSlug: 'roadmap',
        targetLabel: 'Roadmap',
        connectionType: 'wikilink',
        linkText: 'Roadmap',
        linkContext: 'See Roadmap for #Project',
      },
      {
        targetType: 'tag',
        targetSlug: '#project',
        targetLabel: '#project',
        connectionType: 'tag',
        linkText: '#project',
        linkContext: 'See Roadmap for #Project',
      },
    ]);
  });
});
