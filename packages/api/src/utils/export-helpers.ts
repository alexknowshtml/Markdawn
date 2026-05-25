import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { yDocToMarkdown } from '@markdawn/shared/yjs-helpers';
import { pool } from '../db/connection';

/**
 * Matches markdown image syntax: ![alt](src) with optional title.
 * Capture groups: 1=alt, 2=src (angle-bracket form), 3=src (bare form),
 * 4=title (double-quoted), 5=title (single-quoted), 6=title (parenthesized).
 */
const IMAGE_REGEX =
  /!\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\)/g;

const CODE_FENCE_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;

const PLACEHOLDER_PREFIX = '\u0000CODE_';
const PLACEHOLDER_SUFFIX = '\u0000';

interface ImageMatch {
  full: string;
  alt: string;
  src: string;
  title: string;
  titleDelim: '"' | "'" | '()' | '';
}

function maskCodeBlocks(markdown: string): { masked: string; blocks: string[] } {
  const blocks: string[] = [];
  const masked = markdown
    .replace(CODE_FENCE_REGEX, (m) => {
      blocks.push(m);
      return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`;
    })
    .replace(INLINE_CODE_REGEX, (m) => {
      blocks.push(m);
      return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`;
    });
  return { masked, blocks };
}

function restoreCodeBlocks(masked: string, blocks: string[]): string {
  let result = masked;
  for (let i = 0; i < blocks.length; i++) {
    result = result.replace(`${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`, blocks[i] ?? '');
  }
  return result;
}

function extractSrcFromMatch(match: RegExpExecArray): string | null {
  // Group 2 is <url> form, group 3 is bare url form
  return match[2] ?? match[3] ?? null;
}

function isValidUploadFilename(filename: string): boolean {
  if (!filename || filename.startsWith('.')) return false;
  return /^[a-zA-Z0-9\-_.]+$/.test(filename);
}

function resolveMimeType(header: string): string | null {
  const match = header.match(/data:(image\/[\w+.-]+);base64/);
  if (!match) return null;
  return match[1] ?? null;
}

const MIME_TO_EXT: Record<string, string> = {
  'vnd.microsoft.icon': 'ico',
  'x-icon': 'ico',
};

function resolveExtension(mimeType: string): string {
  const parts = mimeType.split('/');
  const subtype = parts[1] ?? 'bin';
  // Known MIME→extension mappings for non-standard subtypes
  if (MIME_TO_EXT[subtype]) return MIME_TO_EXT[subtype];
  // image/svg+xml → svg (everything after + is the vendor extension)
  const base = subtype.split('+')[0] ?? subtype;
  return base;
}

/**
 * Result of extracting images from markdown.
 */
export interface ExtractedImages {
  markdown: string;
  assets: Map<string, Buffer>;
}

/**
 * Scans markdown for images, extracts them from disk or decodes base64,
 * and rewrites references to use relative ./assets/ paths.
 *
 * Handles three image source types:
 * 1. Server URLs: /api/uploads/filename.png → read from uploads/ directory
 * 2. Base64 data URIs: data:image/png;base64,... → decode to buffer
 * 3. External URLs: https://... → left as-is (not downloaded)
 *
 * Code blocks and inline code are masked before scanning to prevent
 * image syntax inside code from being corrupted.
 */
export async function extractImages(
  markdown: string,
  uploadsDir: string,
  workspaceId?: string,
): Promise<ExtractedImages> {
  const { masked, blocks } = maskCodeBlocks(markdown);

  const assets = new Map<string, Buffer>();
  const urlToAssetName = new Map<string, string>();
  const contentHashToAssetName = new Map<string, string>();
  let result = masked;

  const matches: ImageMatch[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
  while ((match = IMAGE_REGEX.exec(masked)) !== null) {
    const src = extractSrcFromMatch(match);
    if (!src) continue;
    const title = match[4] ?? match[5] ?? match[6] ?? '';
    const titleDelim =
      match[4] !== undefined
        ? '"'
        : match[5] !== undefined
          ? "'"
          : match[6] !== undefined
            ? '()'
            : '';
    matches.push({ full: match[0], alt: match[1] ?? '', src, title, titleDelim });
  }

  const serverFilenames = new Set<string>();
  for (const { src } of matches) {
    if (src.startsWith('/api/uploads/') || src.startsWith('/uploads/')) {
      const filename = src.startsWith('/api/uploads/')
        ? src.replace('/api/uploads/', '')
        : src.replace('/uploads/', '');
      if (isValidUploadFilename(filename)) {
        serverFilenames.add(filename);
      }
    }
  }

  const authorizedFiles = new Set<string>();
  if (workspaceId && serverFilenames.size > 0) {
    const uploadResult = await pool.query(
      'select filename from uploads where filename = any($1) and workspace_id = $2',
      [Array.from(serverFilenames), workspaceId],
    );
    for (const row of uploadResult.rows as { filename: string }[]) {
      authorizedFiles.add(row.filename);
    }
  }

  for (const { full, alt, src, title, titleDelim } of matches) {
    let buffer: Buffer | null = null;
    let assetName: string | null = null;

    if (src.startsWith('data:image/')) {
      const commaIdx = src.indexOf(',');
      if (commaIdx === -1) continue;

      const header = src.slice(0, commaIdx);
      const data = src.slice(commaIdx + 1);

      const mimeType = resolveMimeType(header);
      if (!mimeType) continue;

      const ext = resolveExtension(mimeType);

      try {
        const decoded = Buffer.from(data, 'base64');
        const hash = createHash('sha256').update(decoded).digest('hex').slice(0, 12);
        assetName = `image-${hash}.${ext}`;
        buffer = decoded;
      } catch {
        continue;
      }
    } else if (src.startsWith('/api/uploads/') || src.startsWith('/uploads/')) {
      const filename = src.startsWith('/api/uploads/')
        ? src.replace('/api/uploads/', '')
        : src.replace('/uploads/', '');
      if (!isValidUploadFilename(filename)) continue;

      if (workspaceId && !authorizedFiles.has(filename)) continue;

      const filePath = path.join(uploadsDir, filename);
      try {
        buffer = await readFile(filePath);
        assetName = filename;
      } catch {
        continue;
      }
    } else {
      continue;
    }

    if (!buffer || !assetName) continue;

    const titlePart = title
      ? titleDelim === '()'
        ? ` (${title})`
        : ` ${titleDelim}${title}${titleDelim}`
      : '';

    if (urlToAssetName.has(src)) {
      const existing = urlToAssetName.get(src);
      if (existing) {
        result = result.replaceAll(full, `![${alt}](./assets/${existing}${titlePart})`);
      }
      continue;
    }

    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const hashToName = contentHashToAssetName.get(contentHash);
    let finalName = hashToName ?? assetName;

    if (hashToName) {
      finalName = hashToName;
    } else if (assets.has(finalName) && !assets.get(finalName)?.equals(buffer)) {
      const ext = path.extname(assetName);
      const base = path.basename(assetName, ext);
      let counter = 1;
      while (assets.has(finalName) && !assets.get(finalName)?.equals(buffer)) {
        finalName = `${base}-${counter}${ext}`;
        counter++;
      }
    }

    assets.set(finalName, buffer);
    contentHashToAssetName.set(contentHash, finalName);
    urlToAssetName.set(src, finalName);
    result = result.replaceAll(full, `![${alt}](./assets/${finalName}${titlePart})`);
  }

  return { markdown: restoreCodeBlocks(result, blocks), assets };
}

/**
 * Converts properties + icon to a YAML frontmatter string.
 * Returns empty string if there's nothing to put in frontmatter.
 */
export function serializeFrontmatter(
  properties: Record<string, unknown> | null,
  icon: string | null,
): string {
  const data: Record<string, unknown> = {};

  if (icon) {
    data.icon = icon;
  }

  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties)) {
      if (value !== null && value !== undefined) {
        data[key] = value;
      }
    }
  }

  if (Object.keys(data).length === 0) return '';

  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    const keyStr = yamlScalar(key);
    if (Array.isArray(value)) {
      if (value.length > 0) {
        lines.push(`${keyStr}:`);
        for (const item of value) {
          lines.push(`  - ${yamlScalar(item)}`);
        }
      } else {
        lines.push(`${keyStr}: []`);
      }
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${keyStr}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${keyStr}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    const needsQuotes =
      value === '' ||
      value === 'true' ||
      value === 'false' ||
      value === 'null' ||
      value === '~' ||
      value === 'yes' ||
      value === 'no' ||
      value === 'on' ||
      value === 'off' ||
      /^[0-9]/.test(value) ||
      /[:#]/.test(value) ||
      /^[!&*?'"|>{%[]/.test(value) ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes('\n') ||
      value.includes('\r') ||
      value.includes('\t');
    if (needsQuotes) {
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      return `"${escaped}"`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '~';
  }
  return String(value);
}

/**
 * Converts a page's Yjs binary content to a full markdown document
 * including YAML frontmatter (properties + icon) and a title heading.
 */
export function pageToMarkdown(
  ydoc: Buffer | Uint8Array | null,
  properties: Record<string, unknown> | null,
  icon: string | null,
  title?: string,
): string {
  let body = '';
  if (ydoc && ydoc.length > 0) {
    body = yDocToMarkdown(ydoc instanceof Buffer ? new Uint8Array(ydoc) : ydoc);
  }

  const frontmatter = serializeFrontmatter(properties, icon);

  const heading = title ? `# ${title}\n\n` : '';

  return frontmatter + heading + body;
}
