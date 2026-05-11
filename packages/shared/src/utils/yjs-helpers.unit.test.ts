import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extractConnectionsFromYDoc, yDocToMarkdown } from './yjs-helpers';

function encodeFragment(children: Y.XmlElement[]): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prosemirror');
  fragment.push(children);
  return Y.encodeStateAsUpdate(doc);
}

function paragraph(children: (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const node = new Y.XmlElement('paragraph');
  node.push(children);
  return node;
}

function text(value: string): Y.XmlText {
  return new Y.XmlText(value);
}

describe('yjs helpers', () => {
  it('serializes tag nodes to markdown', () => {
    const tag = new Y.XmlElement('tag');
    tag.setAttribute('name', 'Project');
    const update = encodeFragment([paragraph([text('Track '), tag])]);

    expect(yDocToMarkdown(update)).toBe('Track #Project\n\n');
  });

  it('extracts page and tag connections from Yjs documents', () => {
    const link = new Y.XmlElement('wikiLink');
    link.setAttribute('targetId', '11111111-1111-1111-1111-111111111111');
    link.setAttribute('path', 'Roadmap');
    link.setAttribute('label', 'Roadmap');

    const tag = new Y.XmlElement('tag');
    tag.setAttribute('name', 'Project');

    const update = encodeFragment([paragraph([text('See '), link, text(' for '), tag])]);

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
