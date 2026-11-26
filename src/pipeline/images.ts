// Copies a site's product images to R2 and serves them from our own host. Stores
// on PrismRBS refuse HTTPS from outside the US, and TikTok fetches images from
// abroad. Only the TikTok file uses these; Meta reads the store fine.
//
//   finalize -> reconcile the image list -> mirror messages (5 images each)
//   mirror   -> fetch, check the bytes, store under a hash of the content
//   the next published run's feed picks up whatever has been copied
//
// Until an image is copied the feed keeps the store's URL, so turning this on
// can't empty a feed. Files are named by content: a changed image gets a new
// URL, so platforms refetch it.

import { sniffImage, IMAGE_CONTENT_TYPES, MIN_IMAGE_PX } from '../core/image.ts';
import type { ImageMirror } from '../core/feed.ts';
import { HttpClient, mapLimit, siteHosts } from '../core/http.ts';
import type { Site } from '../core/site.ts';
import type { CrawlMessage } from './run.ts';
import { imagesDue, listImages, reconcileImages, saveImageResults, type ImageResult } from './store.ts';

export const IMAGES_PER_MESSAGE = 5;
/** Per published run. Runs are 2 hours apart, so a 4,000-image store fills in about 8 hours. */
const IMAGES_PER_PASS = 1000;
/** Well above the largest seen (4.5 MB), and a Worker holds the whole file in memory. */
const MAX_IMAGE_BYTES = 15_000_000;
/** A store can replace an image at the same URL; re-read each one this often. */
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const imageKey = (siteId: string, file: string): string => `images/${siteId}/${file}`;

/** Source URL to public URL, or null for an image known to be unusable. Not-yet-copied images are absent. */
export async function imageMirror(env: Env, siteId: string): Promise<ImageMirror> {
  const mirror = new Map<string, string | null>();
  for (const row of await listImages(env.DB, siteId)) {
    if (row.status === 'pending') continue;
    const usable = row.status === 'ok' && row.file !== null && (row.width ?? 0) >= MIN_IMAGE_PX && (row.height ?? 0) >= MIN_IMAGE_PX;
    mirror.set(row.source_url, usable ? `${env.PUBLIC_URL}/images/${siteId}/${row.file}` : null);
  }
  return mirror;
}

/** Brings the image list in line with the feed that was just published and queues what's due. */
export async function syncImages(env: Env, site: Site, runId: string, urls: readonly string[]): Promise<Record<string, number>> {
  // The crawler only fetches from the site itself. Images on another host stay on their own URL.
  const hosts = siteHosts(site.baseUrl);
  const onSite = urls.filter((u) => hosts.has(new URL(u).hostname.toLowerCase()));
  const { added, removed } = await reconcileImages(env.DB, site.id, onSite);
  const due = await imagesDue(env.DB, site.id, new Date(Date.now() - REFRESH_AFTER_MS).toISOString(), IMAGES_PER_PASS);
  const messages: Array<{ body: CrawlMessage }> = [];
  for (let i = 0; i < due.length; i += IMAGES_PER_MESSAGE) {
    messages.push({ body: { type: 'mirror', runId, siteId: site.id, urls: due.slice(i, i + IMAGES_PER_MESSAGE) } });
  }
  for (let i = 0; i < messages.length; i += 100) await env.CRAWL.sendBatch(messages.slice(i, i + 100));
  return { images: onSite.length, otherHosts: urls.length - onSite.length, added, removed, queued: due.length };
}

async function mirrorOne(bucket: R2Bucket, siteId: string, url: string, http: HttpClient): Promise<ImageResult> {
  const res = await http.getBytes(url);
  if (!res.ok) {
    // Worth another try: refused or timed out (status 0), rate limited, server errors.
    const recoverable = res.status === 0 || res.status === 429 || res.status >= 500;
    return { kind: recoverable ? 'retry' : 'bad', url, error: res.error };
  }
  const info = sniffImage(res.bytes);
  if (!info) return { kind: 'bad', url, error: `not a JPG or PNG (${res.contentType.slice(0, 60) || 'no content type'})` };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', res.bytes));
  const hash = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const file = `${hash}.${info.format}`;
  const key = imageKey(siteId, file);
  if (!(await bucket.head(key))) await bucket.put(key, res.bytes, { httpMetadata: { contentType: IMAGE_CONTENT_TYPES[info.format] } });
  return { kind: 'ok', url, file, width: info.width, height: info.height, bytes: res.bytes.byteLength };
}

export async function handleMirror(env: Env, msg: { siteId: string; urls: readonly string[] }, site: Site | null): Promise<void> {
  if (!site?.config.mirrorImages) return;
  const http = new HttpClient({ allowedHosts: siteHosts(site.baseUrl), userAgent: env.USER_AGENT, maxBytes: MAX_IMAGE_BYTES });
  const results = await mapLimit(msg.urls, site.config.crawlConcurrency, (url) => mirrorOne(env.FEEDS, msg.siteId, url, http));
  await saveImageResults(env.DB, msg.siteId, results);
}
