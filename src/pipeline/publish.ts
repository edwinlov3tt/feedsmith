import { csvHeader, csvLine, feedProblem, jpgOrPngImages, TIKTOK_COLUMNS, tiktokProblem, toFeedRow, toTikTokRow, type ImageMirror } from '../core/feed.ts';
import type { CatalogType } from '../core/model.ts';
import { allVariants } from './store.ts';

export const feedKey = (siteId: string): string => `feeds/${siteId}/meta.csv`;
export const tiktokFeedKey = (siteId: string): string => `feeds/${siteId}/tiktok.csv`;

export interface BuiltFile {
  body: string;
  items: number;
  skipped: Record<string, number>;
}

export interface BuiltFeed extends BuiltFile {
  /** The TikTok catalog file; null for vehicles, which TikTok takes in another format. */
  tiktok: BuiltFile | null;
  /** Store image links the TikTok file draws on; filled only when the site mirrors images. */
  imageUrls: string[];
}

function emptyFile(header: string): BuiltFile & { parts: string[] } {
  return { body: '', items: 0, skipped: {}, parts: [header] };
}

/** The Meta CSV (and, for products, the TikTok CSV) for a site from current variant state, in one read. */
export async function buildFeed(db: D1Database, siteId: string, type: CatalogType, mirror?: ImageMirror): Promise<BuiltFeed> {
  const imageUrls = new Set<string>();
  const meta = emptyFile(csvHeader(type));
  const tiktok = type === 'commerce' ? emptyFile(csvHeader(type, TIKTOK_COLUMNS)) : null;
  const add = (file: BuiltFile & { parts: string[] }, problem: string | null, line: () => string): void => {
    if (problem) {
      file.skipped[problem] = (file.skipped[problem] ?? 0) + 1;
      return;
    }
    file.parts.push(line());
    file.items++;
  };
  for await (const page of allVariants(db, siteId)) {
    for (const v of page) {
      add(meta, feedProblem(v), () => csvLine(toFeedRow(v), type));
      if (!tiktok) continue;
      // Every candidate image, including ones the mirror has ruled out: a store can fix a bad one.
      if (mirror && !tiktokProblem(v)) for (const url of jpgOrPngImages(v)) imageUrls.add(url);
      add(tiktok, tiktokProblem(v, mirror), () => csvLine(toTikTokRow(v, mirror), type, TIKTOK_COLUMNS));
    }
  }
  const done = ({ parts, items, skipped }: BuiltFile & { parts: string[] }): BuiltFile => {
    const body = parts.join('');
    // Two ~10 MB files are in memory at once; let the pieces go as soon as each is joined.
    parts.length = 0;
    return { body, items, skipped };
  };
  return { ...done(meta), tiktok: tiktok ? done(tiktok) : null, imageUrls: [...imageUrls] };
}

/** Item count of a feed file currently live (the Meta one by default), or null when none has been published. */
export async function publishedItems(bucket: R2Bucket, siteId: string, key: string = feedKey(siteId)): Promise<number | null> {
  const head = await bucket.head(key);
  const n = Number(head?.customMetadata?.['items']);
  return head && Number.isFinite(n) ? n : null;
}

async function putFile(bucket: R2Bucket, key: string, runId: string, file: BuiltFile): Promise<{ items: number; skipped: Record<string, number>; bytes: number }> {
  await bucket.put(key, file.body, {
    httpMetadata: { contentType: 'text/csv; charset=utf-8' },
    customMetadata: { runId, items: String(file.items), publishedAt: new Date().toISOString() },
  });
  return { items: file.items, skipped: file.skipped, bytes: new TextEncoder().encode(file.body).byteLength };
}

/**
 * Writes the site's feed files; both come from the same variants and passed
 * the same run checks. The TikTok file is secondary: failing to write it is
 * recorded, not thrown, so it can't hold up the Meta feed and push.
 */
export async function writeFeed(
  bucket: R2Bucket,
  siteId: string,
  runId: string,
  feed: BuiltFeed,
): Promise<{ items: number; skipped: Record<string, number>; bytes: number; tiktok?: { items: number; skipped: Record<string, number>; bytes: number } | { error: string } }> {
  const meta = await putFile(bucket, feedKey(siteId), runId, feed);
  if (!feed.tiktok) return meta;
  try {
    return { ...meta, tiktok: await putFile(bucket, tiktokFeedKey(siteId), runId, feed.tiktok) };
  } catch (err) {
    return { ...meta, tiktok: { error: err instanceof Error ? err.message : String(err) } };
  }
}
