// Image copying over the real pipeline: SQLite, an in-memory queue and R2,
// against a stubbed store serving real PrismRBS pages and made-up image bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/api/app.ts';
import { handleDeadLetter, handleMessage, startRun } from '../src/pipeline/run.ts';
import { insertSite } from '../src/pipeline/store.ts';
import { D1Shim, QueueShim, R2Shim } from './d1-shim.ts';
import { fixture, testSite } from './helpers.ts';

const ADMIN = 'integration-admin-token-0123456789';
const PUBLIC_URL = 'https://feeds.example.test';
const PRODUCTS = new Map([
  ['211098', fixture('prism-detail-multi.html')],
  ['206700', fixture('prism-detail-single.html')],
]);

function jpeg(width: number, height: number, seed = 0): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, seed]);
}
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

type ImageAnswer = () => Response;
let images: Map<string, ImageAnswer>;
let defaultImage: ImageAnswer;
let imageFetches: string[];

function stubStore(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const page = url.pathname.split('/').pop() ?? '';
    if (url.pathname.includes('/product_images/')) {
      imageFetches.push(page);
      return (images.get(page) ?? defaultImage)();
    }
    if (page === '' || page === 'shop_main.asp') return new Response('<a href="shop_product_list.asp?catalog_id=454">T-Shirts</a>');
    if (page === 'shop_product_list.asp') {
      const cards = [...PRODUCTS.keys()].map((id) => `<div class="product"><a href="shop_product_detail.asp?pf_id=${id}&type=1">x</a></div>`).join('');
      return new Response(`<h1><span>T-Shirts</span></h1><span class="paging-items-info">2 items</span><span class="paging-page-info">page 1 of 1</span><section aria-label="Catalog products" class="products-container">${cards}</section>`);
    }
    if (page === 'shop_product_detail.asp') return new Response(PRODUCTS.get(url.searchParams.get('pf_id') ?? '') ?? fixture('prism-detail-missing.html'));
    return new Response('not found', { status: 404 });
  });
}

let db: D1Shim;
let queue: QueueShim;
let r2: R2Shim;
let env: Env;

async function drain(): Promise<void> {
  for (let guard = 0; queue.messages.length > 0 && guard < 500; guard++) {
    const msg = queue.messages.shift();
    if (msg) await handleMessage(env, msg.body, msg.id);
  }
}

async function publish(): Promise<void> {
  const res = await startRun(env, 'supe-store', 'full');
  if (res.kind !== 'started') throw new Error(`run not started: ${res.kind}`);
  await drain();
  const row = db.rows('SELECT status, notes_json FROM runs WHERE id = ?', res.run.id)[0];
  expect(row?.['status']).toBe('published');
}

const adminGet = (path: string): Promise<Response> => Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${ADMIN}` } }, env));
const tiktokFile = (): string => r2.objects.get('feeds/supe-store/tiktok.csv') ?? '';
const metaFile = (): string => r2.objects.get('feeds/supe-store/meta.csv') ?? '';
const imageRows = (): Record<string, unknown>[] => db.rows('SELECT source_url, status, width, height, error, file FROM images ORDER BY source_url');
const imageStatus = (name: string): unknown => imageRows().find((r) => String(r['source_url']).endsWith(`/${name}`))?.['status'];

beforeEach(async () => {
  db = new D1Shim();
  queue = new QueueShim();
  r2 = new R2Shim();
  images = new Map();
  imageFetches = [];
  defaultImage = () => new Response(jpeg(800, 800));
  // Test doubles implement only the binding methods the pipeline calls.
  env = { DB: db, CRAWL: queue, FEEDS: r2, USER_AGENT: 'test', META_GRAPH_VERSION: 'v23.0', ADMIN_TOKEN: ADMIN, TOKEN_ENC_KEY: 'x', PUBLIC_URL } as unknown as Env;
  stubStore();
  await insertSite(db as unknown as D1Database, testSite({ id: 'supe-store' }, { mirrorImages: true }), 'hash');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image copying', () => {
  it('fills in over two runs: store links first, our links once copied', async () => {
    await publish();
    // The run that starts copying can't use the copies yet, so nothing is lost meanwhile.
    expect(imageFetches.length).toBeGreaterThan(0);
    expect(tiktokFile()).toContain('universitysupplystore.com/outerweb/product_images/');
    expect(tiktokFile()).not.toContain(PUBLIC_URL);
    expect(imageRows().every((r) => r['status'] === 'ok')).toBe(true);

    await publish();
    const lines = tiktokFile().split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(tiktokFile()).not.toContain('outerweb/product_images/');
    expect(tiktokFile()).toContain(`${PUBLIC_URL}/images/supe-store/`);
  });

  it('leaves the Meta feed on the store links', async () => {
    await publish();
    await publish();
    expect(metaFile()).toContain('universitysupplystore.com/outerweb/product_images/');
    expect(metaFile()).not.toContain(PUBLIC_URL);
  });

  it('does nothing for a site with copying off', async () => {
    db.db.prepare('DELETE FROM sites').run();
    await insertSite(db as unknown as D1Database, testSite({ id: 'supe-store' }), 'hash');
    await publish();
    expect(imageFetches).toHaveLength(0);
    expect(imageRows()).toHaveLength(0);
    expect(tiktokFile()).toContain('outerweb/product_images/');
  });

  it('serves a copied image publicly, with its type and a long cache life', async () => {
    images.set('14033360L.jpg', () => new Response(jpeg(900, 900, 7)));
    await publish();
    const file = String(imageRows().find((r) => String(r['source_url']).endsWith('14033360L.jpg'))?.['file']);
    expect(file).toMatch(/^[0-9a-f]{32}\.jpg$/);
    const res = await app.request(`/images/supe-store/${file}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg(900, 900, 7));
  });

  it('refuses image paths that are not our file names', async () => {
    for (const path of ['/images/supe-store/feed.csv', '/images/supe-store/..%2F..%2Ffeeds%2Fsupe-store%2Fmeta.csv', '/images/supe-store/0123456789abcdef0123456789abcdef.html']) {
      expect((await app.request(path, {}, env)).status).toBe(400);
    }
    expect((await app.request('/images/supe-store/0123456789abcdef0123456789abcdef.jpg', {}, env)).status).toBe(404);
  });

  it('names a file by its real format, not its URL', async () => {
    images.set('14033360L.jpg', () => new Response(png(800, 800)));
    await publish();
    expect(String(imageRows().find((r) => String(r['source_url']).endsWith('14033360L.jpg'))?.['file'])).toMatch(/\.png$/);
  });

  it('drops a web page served at an image link, and an image under 500 px', async () => {
    images.set('14033360L.jpg', () => new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }));
    await publish();
    expect(imageStatus('14033360L.jpg')).toBe('bad');
    await publish();
    const run = db.rows('SELECT notes_json FROM runs ORDER BY started_at DESC LIMIT 1')[0];
    const notes = JSON.parse(String(run?.['notes_json'])) as { feed: { tiktok: { skipped: Record<string, number> } } };
    expect(notes.feed.tiktok.skipped['image broken or under 500x500']).toBe(1);
    expect(tiktokFile()).not.toContain('14033360L.jpg');
    // Meta still gets the item.
    expect(metaFile()).toContain('14033360L.jpg');

    db.db.prepare('DELETE FROM images').run();
    images.set('14033360L.jpg', () => new Response(jpeg(400, 400)));
    await publish();
    expect(imageStatus('14033360L.jpg')).toBe('ok');
    await publish();
    expect(tiktokFile()).not.toContain('14033360L.jpg');
    const status = (await (await adminGet('/admin/sites/supe-store/images')).json()) as { underMinSize: number; enabled: boolean };
    expect(status).toMatchObject({ enabled: true, underMinSize: 1 });
  });

  it('keeps the store link when the store refuses or errors, and tries again next run', async () => {
    images.set('14033360L.jpg', () => new Response('busy', { status: 503 }));
    await publish();
    expect(imageStatus('14033360L.jpg')).toBe('pending');
    await publish();
    expect(tiktokFile()).toContain('14033360L.jpg');
    images.delete('14033360L.jpg');
    await publish();
    expect(imageStatus('14033360L.jpg')).toBe('ok');
  }, 20_000);

  it('keeps a good copy through a store outage', async () => {
    await publish();
    images.set('14033360L.jpg', () => new Response('busy', { status: 503 }));
    db.db.prepare("UPDATE images SET checked_at = '2000-01-01T00:00:00.000Z'").run();
    await publish();
    expect(imageStatus('14033360L.jpg')).toBe('ok');
    expect(tiktokFile()).not.toContain('14033360L.jpg');
  }, 20_000);

  it('fetches each image once, then again only when it is due for a refresh', async () => {
    await publish();
    const first = imageFetches.length;
    await publish();
    expect(imageFetches.length).toBe(first);
    db.db.prepare("UPDATE images SET checked_at = '2000-01-01T00:00:00.000Z'").run();
    await publish();
    expect(imageFetches.length).toBe(first * 2);
  });

  it('gives a replaced image a new file, so platforms refetch it', async () => {
    images.set('14033360L.jpg', () => new Response(jpeg(800, 800, 1)));
    await publish();
    const before = imageRows().find((r) => String(r['source_url']).endsWith('14033360L.jpg'))?.['file'];
    images.set('14033360L.jpg', () => new Response(jpeg(800, 800, 2)));
    db.db.prepare("UPDATE images SET checked_at = '2000-01-01T00:00:00.000Z'").run();
    await publish();
    const after = imageRows().find((r) => String(r['source_url']).endsWith('14033360L.jpg'))?.['file'];
    expect(after).not.toBe(before);
  });

  it('forgets images no item uses any more', async () => {
    await publish();
    db.db.prepare("INSERT INTO images (site_id, source_url, status) VALUES ('supe-store', 'https://www.universitysupplystore.com/outerweb/product_images/old.jpg', 'ok')").run();
    await publish();
    expect(imageStatus('old.jpg')).toBeUndefined();
  });

  it('survives a dead-lettered image message: the images stay due', async () => {
    await handleDeadLetter(env, { type: 'mirror', runId: crypto.randomUUID(), siteId: 'supe-store', urls: ['https://www.universitysupplystore.com/outerweb/product_images/a.jpg'] });
    expect(imageRows()).toHaveLength(0);
  });

  it('requires the admin token for status and reports progress', async () => {
    expect((await app.request('/admin/sites/supe-store/images', {}, env)).status).toBe(401);
    await publish();
    const res = await adminGet('/admin/sites/supe-store/images');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; total: number; copied: number; pending: number; bytes: number };
    expect(body.enabled).toBe(true);
    expect(body.total).toBeGreaterThan(0);
    expect(body.copied).toBe(body.total);
    expect(body.pending).toBe(0);
    expect(body.bytes).toBeGreaterThan(0);
    expect((await adminGet('/admin/sites/nope-nope/images')).status).toBe(404);
  });
});
