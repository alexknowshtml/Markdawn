import * as Y from 'yjs';

export type ConnectionTargetType = 'page' | 'tag' | 'user' | 'external';
export type ConnectionType = 'wikilink' | 'tag' | 'mention' | 'embed' | 'heading' | 'url';

export interface ConnectionDraft {
  targetType: ConnectionTargetType;
  targetId?: string;
  targetSlug: string;
  targetLabel: string;
  connectionType: ConnectionType;
  linkText?: string;
  linkContext?: string;
}

export function yDocToMarkdown(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const fragment = doc.getXmlFragment('prosemirror');
  return xmlElementToMarkdown(fragment);
}

export function extractConnectionsFromYDoc(update: Uint8Array): ConnectionDraft[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const fragment = doc.getXmlFragment('prosemirror');
  return extractConnectionsFromXml(fragment);
}

function xmlElementToMarkdown(element: Y.XmlFragment | Y.XmlElement): string {
  let markdown = '';

  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);

    if (item instanceof Y.XmlText) {
      markdown += item.toString();
    } else if (item instanceof Y.XmlElement) {
      const type = item.nodeName;

      switch (type) {
        case 'paragraph':
          markdown += `${xmlElementToMarkdown(item)}\n\n`;
          break;
        case 'heading': {
          const level = Number.parseInt(item.getAttribute('level') || '1', 10);
          markdown += `${'#'.repeat(level)} ${xmlElementToMarkdown(item)}\n\n`;
          break;
        }
        case 'bullet_list':
          markdown += `${xmlElementToMarkdown(item)}\n`;
          break;
        case 'ordered_list':
          markdown += `${xmlElementToMarkdown(item)}\n`;
          break;
        case 'list_item':
          markdown += `- ${xmlElementToMarkdown(item).trim()}\n`;
          break;
        case 'wikiLink': {
          const path = item.getAttribute('path') || '';
          const label = item.getAttribute('label') || '';
          const heading = item.getAttribute('heading') || '';
          const target = heading ? `${path}#${heading}` : path;
          if (path === label) {
            markdown += `[[${target}]]`;
          } else {
            markdown += `[[${target}|${label}]]`;
          }
          break;
        }
        case 'tag': {
          const name = item.getAttribute('name') || item.getAttribute('value') || '';
          markdown += name ? `#${name}` : '';
          break;
        }
        case 'inlineCode':
          markdown += `\`${xmlElementToMarkdown(item)}\``;
          break;
        case 'code_block':
          markdown += `\`\`\`${item.getAttribute('language') || ''}\n${xmlElementToMarkdown(item)}\n\`\`\`\n\n`;
          break;
        default:
          markdown += xmlElementToMarkdown(item);
      }
    }
  }

  return markdown;
}

function extractConnectionsFromXml(element: Y.XmlFragment | Y.XmlElement): ConnectionDraft[] {
  const connections: ConnectionDraft[] = [];

  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);
    if (!(item instanceof Y.XmlElement)) continue;

    const context = xmlElementPlainText(item).trim();
    collectConnections(item, context, connections);
  }

  return connections;
}

function collectConnections(
  element: Y.XmlElement,
  context: string,
  connections: ConnectionDraft[],
): void {
  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);
    if (!(item instanceof Y.XmlElement)) continue;

    if (item.nodeName === 'wikiLink') {
      const path = item.getAttribute('path') || '';
      const label = item.getAttribute('label') || path;
      const targetId = item.getAttribute('targetId') || '';
      const heading = item.getAttribute('heading') || '';
      const target = heading ? `${path}#${heading}` : path;
      const targetSlug = normalizePageSlug(path);

      if (targetSlug) {
        const draft: ConnectionDraft = {
          targetType: 'page',
          targetSlug,
          targetLabel: target || label,
          connectionType: heading ? 'heading' : 'wikilink',
          linkText: label || target || path,
        };
        if (context) draft.linkContext = context;
        if (targetId) draft.targetId = targetId;
        connections.push(draft);
      }
      continue;
    }

    if (item.nodeName === 'tag') {
      const name = item.getAttribute('name') || item.getAttribute('value') || '';
      const tagSlug = normalizeTagSlug(name);
      if (tagSlug) {
        connections.push({
          targetType: 'tag',
          targetSlug: tagSlug,
          targetLabel: tagSlug,
          connectionType: 'tag',
          linkText: tagSlug,
          ...(context ? { linkContext: context } : {}),
        });
      }
      continue;
    }

    collectConnections(item, context, connections);
  }
}

function xmlElementPlainText(element: Y.XmlFragment | Y.XmlElement): string {
  let text = '';

  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);
    if (item instanceof Y.XmlText) {
      text += item.toString();
      continue;
    }

    if (!(item instanceof Y.XmlElement)) continue;

    if (item.nodeName === 'wikiLink') {
      const label = item.getAttribute('label') || item.getAttribute('path') || '';
      text += label;
      continue;
    }

    if (item.nodeName === 'tag') {
      const name = item.getAttribute('name') || item.getAttribute('value') || '';
      text += name ? `#${name}` : '';
      continue;
    }

    text += xmlElementPlainText(item);
  }

  return text;
}

export function normalizePageSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTagSlug(value: string): string {
  const trimmed = value.trim().replace(/^#+/, '').toLowerCase();
  return trimmed ? `#${trimmed}` : '';
}

const WIKILINK_REGEX = /(?<!!)\[\[([^#|\]]+)(?:#(\^[^|]+)|#([^|\]]+))?(?:\|([^\]]+))?\]\]/g;

export interface WikilinkMatch {
  page: string;
  blockId: string | undefined;
  heading: string | undefined;
  alias: string | undefined;
}

export function extractWikilinks(content: string): WikilinkMatch[] {
  const results: WikilinkMatch[] = [];
  let match: RegExpExecArray | null;

  WIKILINK_REGEX.lastIndex = 0;

  while (true) {
    match = WIKILINK_REGEX.exec(content);
    if (match === null) break;

    const page = match[1];
    if (!page) continue;

    results.push({
      page: page.trim(),
      blockId: match[2]?.trim(),
      heading: match[3]?.trim(),
      alias: match[4]?.trim(),
    });
  }
  return results;
}
