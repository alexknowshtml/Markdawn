import { Hono } from 'hono';
import JSZip from 'jszip';
import { query } from '../db/query';
import { uploadsDir } from '../env';
import { requireAuth } from '../middleware/auth';
import { extractImages, pageToMarkdown } from '../utils/export-helpers';
import { slugifyFilename } from '../utils/filename';

type PageExportRow = {
  id: string;
  title: string | null;
  ydoc: Buffer | null;
  properties: Record<string, unknown> | null;
  icon: string | null;
};

const exportRoute = new Hono();

exportRoute.use('*', requireAuth);

exportRoute.get('/export', async (c) => {
  const user = c.get('user') as { id: string };

  const result = await query(
    `
      select id, title, ydoc, properties, icon
      from pages
      where is_deleted = false
        and id in (select page_id from get_accessible_page_ids($1))
      order by parent_id nulls first, position asc
    `,
    [user.id],
  );

  const pages = result.rows as PageExportRow[];
  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const allAssets = new Map<string, Buffer>();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    const title =
      typeof page.title === 'string' && page.title.trim().length > 0
        ? page.title.trim()
        : 'Untitled';
    const baseSlug = slugifyFilename(title);
    const baseName = baseSlug.length > 0 ? baseSlug : `page-${i + 1}`;
    const seenCount = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, seenCount + 1);
    const filename = seenCount > 0 ? `${baseName}-${seenCount + 1}.md` : `${baseName}.md`;

    let content = pageToMarkdown(page.ydoc, page.properties, page.icon, title);
    const extracted = await extractImages(content, uploadsDir);
    content = extracted.markdown;

    for (const [assetName, assetBuffer] of extracted.assets) {
      if (!allAssets.has(assetName)) {
        allAssets.set(assetName, assetBuffer);
      }
    }

    zip.file(filename, content);
  }

  for (const [assetName, assetBuffer] of allAssets) {
    zip.file(`assets/${assetName}`, assetBuffer);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', 'attachment; filename="markdawn-export.zip"');
  return c.newResponse(arrayBuffer, 200);
});

export default exportRoute;
