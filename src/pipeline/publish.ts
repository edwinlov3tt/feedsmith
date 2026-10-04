import { csvHeader, csvLine, feedProblem, toMetaRow } from '../core/feed.ts';
import { allVariants } from './store.ts';

export const feedKey = (siteId: string): string => `feeds/${siteId}/meta.csv`;

export interface BuiltFeed {
  body: string;
  items: number;
  skipped: Record<string, number>;
}

/** The Meta CSV for a site from current variant state. */
export async function buildFeed(db: D1Database, siteId: string): Promise<BuiltFeed> {
  const parts: string[] = [csvHeader()];
  const skipped: Record<string, number> = {};
  let items = 0;
  for await (const page of allVariants(db, siteId)) {
    for (const v of page) {
      const problem = feedProblem(v);
      if (problem) {
        skipped[problem] = (skipped[problem] ?? 0) + 1;
        continue;
      }
      parts.push(csvLine(toMetaRow(v)));
      items++;
    }
  }
  return { body: parts.join(''), items, skipped };
}

/** Item count of the feed currently live, or null when none has been published. */
export async function publishedItems(bucket: R2Bucket, siteId: string): Promise<number | null> {
  const head = await bucket.head(feedKey(siteId));
  const n = Number(head?.customMetadata?.['items']);
  return head && Number.isFinite(n) ? n : null;
}

export async function writeFeed(bucket: R2Bucket, siteId: string, runId: string, feed: BuiltFeed): Promise<{ items: number; skipped: Record<string, number>; bytes: number }> {
  await bucket.put(feedKey(siteId), feed.body, {
    httpMetadata: { contentType: 'text/csv; charset=utf-8' },
    customMetadata: { runId, items: String(feed.items), publishedAt: new Date().toISOString() },
  });
  return { items: feed.items, skipped: feed.skipped, bytes: new TextEncoder().encode(feed.body).byteLength };
}
