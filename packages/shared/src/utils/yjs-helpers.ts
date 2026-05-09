import * as Y from 'yjs';

export function yDocToMarkdown(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const fragment = doc.getXmlFragment('prosemirror');
  return xmlElementToMarkdown(fragment);
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
          if (path === label) {
            markdown += `[[${path}]]`;
          } else {
            markdown += `[[${path}|${label}]]`;
          }
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
