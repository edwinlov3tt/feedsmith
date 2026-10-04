// The real pipeline (start -> discover -> read -> finalize) over SQLite, an
// in-memory queue and R2, against a stubbed storefront serving real PrismRBS
// pages. Covers redelivery, crashes and the publish gates end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDeadLetter, handleMessage, startRun } from '../src/pipeline/run.ts';
import { insertSite } from '../src/pipeline/store.ts';
import { D1Shim, QueueShim, R2Shim, type QueuedMessage } from './d1-shim.ts';
import { fixture, testSite } from './helpers.ts';

const BASE = 'https://www.universitysupplystore.com/';
const PRODUCTS = new Map([
  ['211098', fixture('prism-detail-multi.html')], // 6 variants
  ['206700', fixture('prism-detail-single.html')], // 1 variant
  ['229', fixture('prism-detail-type3.html')], // 1 variant (book)
]);

function listPage(ids: readonly string[]): string {
  const cards = ids.map((id) => `<div class="product"><a href="shop_product_detail.asp?pf_id=${id}&type=1">x</a></div>`).join('');
  return `<h1><span>T-Shirts</span></h1><span class="paging-items-info">${ids.length} items</span><span class="paging-page-info">page 1 of 1</span><section aria-label="Catalog products" class="products-container">${cards}</section>`;
}

interface Storefront {
  listed: string[];
  detailStatus: number;
}

function stubStore(store: Storefront): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const page = url.pathname.split('/').pop() ?? '';
    if (page === '' || page === 'shop_main.asp') return new Response('<a href="shop_product_list.asp?catalog_id=454">T-Shirts</a>', { status: 200 });
    if (page === 'shop_product_list.asp') return new Response(listPage(store.listed), { status: 200 });
    if (page === 'shop_product_detail.asp') {
      if (store.detailStatus !== 200) return new Response('not found', { status: store.detailStatus });
      const id = url.searchParams.get('pf_id') ?? '';
      const html = PRODUCTS.get(id) ?? fixture('prism-detail-missing.html');
      return new Response(html, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

let db: D1Shim;
let queue: QueueShim;
let r2: R2Shim;
let env: Env;
let store: Storefront;

beforeEach(async () => {
  db = new D1Shim();
  queue = new QueueShim();
  r2 = new R2Shim();
  // Test doubles implement only the binding methods the pipeline calls; the
  // full Cloudflare types (Env) can't be satisfied structurally by them.
  env = { DB: db, CRAWL: queue, FEEDS: r2, USER_AGENT: 'test', META_GRAPH_VERSION: 'v23.0', ADMIN_TOKEN: 'x', TOKEN_ENC_KEY: 'x' } as unknown as Env;
  store = { listed: ['211098', '206700', '229'], detailStatus: 200 };
  stubStore(store);
  await insertSite(db as unknown as D1Database, testSite({ id: 'supe-store' }), 'hash');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Delivers queued messages like Cloudflare would: failures retry, then dead-letter. */
async function drain(opts: { crashOnce?: (m: QueuedMessage) => boolean; maxRetries?: number } = {}): Promise<void> {
  const crashed = new Set<string>();
  for (let guard = 0; queue.messages.length > 0 && guard < 500; guard++) {
    const msg = queue.messages.shift();
    if (!msg) break;
    try {
      if (opts.crashOnce && !crashed.has(msg.id) && opts.crashOnce(msg)) {
        crashed.add(msg.id);
        // Run the handler, then fail as if the worker died before ack.
        await handleMessage(env, msg.body, msg.id);
        throw new Error('crash after handling (injected)');
      }
      await handleMessage(env, msg.body, msg.id);
    } catch {
      if (msg.attempts >= (opts.maxRetries ?? 3)) await handleDeadLetter(env, msg.body);
      else queue.messages.push({ ...msg, attempts: msg.attempts + 1 });
    }
  }
}

const runRow = (id: string): Record<string, unknown> | undefined => db.rows('SELECT status, error, notes_json FROM runs WHERE id = ?', id)[0];
const inStock = (): number => Number(db.rows("SELECT COUNT(*) AS n FROM variants WHERE availability = 'in stock'")[0]?.['n']);
const feedRows = (): number => (r2.objects.get('feeds/supe-store/meta.csv') ?? '').split('\r\n').filter(Boolean).length - 1;

async function fullRun(): Promise<string> {
  const res = await startRun(env, 'supe-store', 'full');
  if (res.kind !== 'started') throw new Error(`run not started: ${res.kind}`);
  return res.run.id;
}

describe('pipeline end to end', () => {
  it('discovers, reads and publishes a feed', async () => {
    const id = await fullRun();
    await drain();
    expect(runRow(id)?.['status']).toBe('published');
    expect(inStock()).toBe(8);
    expect(feedRows()).toBe(8);
  });

  it('allows only one run in progress per site', async () => {
    await fullRun();
    expect((await startRun(env, 'supe-store', 'full')).kind).toBe('busy');
  });

  it('survives every message being redelivered after a crash', async () => {
    const id = await fullRun();
    await drain({ crashOnce: () => true });
    expect(runRow(id)?.['status']).toBe('published');
    expect(inStock()).toBe(8);
    // No duplicate change rows from re-reading.
    expect(Number(db.rows("SELECT COUNT(*) AS n FROM changes WHERE kind = 'created'")[0]?.['n'])).toBe(8);
  });

  it('strikes an undiscovered product once per run, even when finalize is redelivered', async () => {
    await fullRun();
    await drain();
    store.listed = ['211098', '206700']; // book 229 drops out of the listing
    // With 3 products, losing one is a 33% discovery drop: the gate rejects it.
    const gated = await fullRun();
    await drain();
    expect(runRow(gated)?.['status']).toBe('rejected');
    expect(db.rows("SELECT missing_full_runs FROM products WHERE ref_key = '229'")[0]?.['missing_full_runs']).toBe(0);

    db.db.prepare("UPDATE sites SET config_json = json_set(config_json, '$.minDiscoveryRatio', 0.5)").run();
    await fullRun();
    await drain({ crashOnce: (m) => (m.body as { type: string }).type === 'finalize' });
    expect(db.rows("SELECT missing_full_runs, status FROM products WHERE ref_key = '229'")[0]).toEqual({ missing_full_runs: 1, status: 'active' });
    expect(inStock()).toBe(8);

    // Second consecutive miss: now it is gone and its variant sold out.
    await fullRun();
    await drain();
    expect(db.rows("SELECT status FROM products WHERE ref_key = '229'")[0]?.['status']).toBe('gone');
    expect(db.rows("SELECT availability FROM variants WHERE ref_key = '229'")[0]?.['availability']).toBe('out of stock');
  });

  it('rejects a sweep where every product 404s and leaves stock untouched', async () => {
    await fullRun();
    await drain();
    const before = r2.objects.get('feeds/supe-store/meta.csv');
    store.detailStatus = 404;
    const sweep = await startRun(env, 'supe-store', 'sweep');
    if (sweep.kind !== 'started') throw new Error('sweep not started');
    await drain();
    expect(runRow(sweep.run.id)?.['status']).toBe('rejected');
    expect(String(runRow(sweep.run.id)?.['error'])).toMatch(/reported gone/);
    expect(inStock()).toBe(8);
    expect(db.rows("SELECT COUNT(*) AS n FROM products WHERE status = 'active'")[0]?.['n']).toBe(3);
    expect(r2.objects.get('feeds/supe-store/meta.csv')).toBe(before);

    // The site recovers: the next sweep publishes normally.
    store.detailStatus = 200;
    const next = await startRun(env, 'supe-store', 'sweep');
    if (next.kind !== 'started') throw new Error('sweep not started');
    await drain();
    expect(runRow(next.run.id)?.['status']).toBe('published');
  });

  it('finishes a run whose read messages dead-letter, and the error gate decides', async () => {
    const id = await fullRun();
    // Every read throws (as if D1 were down), so reads exhaust retries.
    const reads = (m: QueuedMessage): boolean => (m.body as { type: string }).type === 'read';
    let failing = true;
    const original = handleMessage;
    for (let guard = 0; queue.messages.length > 0 && guard < 200; guard++) {
      const msg = queue.messages.shift();
      if (!msg) break;
      try {
        if (failing && reads(msg)) throw new Error('read failed (injected)');
        await original(env, msg.body, msg.id);
      } catch {
        if (msg.attempts >= 3) await handleDeadLetter(env, msg.body);
        else queue.messages.push({ ...msg, attempts: msg.attempts + 1 });
      }
    }
    failing = false;
    expect(runRow(id)?.['status']).toBe('rejected');
    expect(String(runRow(id)?.['error'])).toMatch(/error rate 100\.0%/);
  });

  it('re-sends reads when discovery was interrupted while enqueueing', async () => {
    const id = await fullRun();
    // Make the read enqueue fail once: the discover message will be redelivered.
    const discover = queue.messages.shift();
    if (!discover) throw new Error('no discover message');
    queue.failSends = 1;
    await expect(handleMessage(env, discover.body, discover.id)).rejects.toThrow(/injected/);
    queue.messages.push({ ...discover, attempts: 2 });
    await drain();
    expect(runRow(id)?.['status']).toBe('published');
    expect(inStock()).toBe(8);
  });

  it('records a product with invalid data as an error and writes nothing for it', async () => {
    PRODUCTS.set('211098', fixture('prism-detail-multi.html').replace('id="defaultImage" value="outerweb/product_images/14342103L.png"', 'id="defaultImage" value="javascript:alert(1)"'));
    try {
      const id = await fullRun();
      await drain();
      expect(db.rows("SELECT outcome, message FROM run_items WHERE ref_key = '211098'")[0]?.['outcome']).toBe('error');
      expect(db.rows("SELECT COUNT(*) AS n FROM variants WHERE ref_key = '211098'")[0]?.['n']).toBe(0);
      // 1 of 3 unreadable is over the 20% error gate, so nothing is published.
      expect(runRow(id)?.['status']).toBe('rejected');
    } finally {
      PRODUCTS.set('211098', fixture('prism-detail-multi.html'));
    }
  });

  it('refuses to publish a feed that collapses (e.g. a config change drops the brand)', async () => {
    const first = await fullRun();
    await drain();
    expect(runRow(first)?.['status']).toBe('published');
    const live = r2.objects.get('feeds/supe-store/meta.csv');
    // What actually happened once: a config update wiped defaultBrand, so most items had no brand.
    // (The book keeps its place: a GTIN satisfies Meta in place of a brand.)
    db.db.prepare("UPDATE sites SET config_json = json_set(config_json, '$.defaultBrand', NULL, '$.brandKeywords', json('[]'))").run();
    const sweep = await startRun(env, 'supe-store', 'sweep');
    if (sweep.kind !== 'started') throw new Error('sweep not started');
    await drain();
    expect(runRow(sweep.run.id)?.['status']).toBe('rejected');
    expect(String(runRow(sweep.run.id)?.['error'])).toMatch(/feed would shrink from 8 to 1 items/);
    expect(r2.objects.get('feeds/supe-store/meta.csv')).toBe(live);
  });

  it('gives a SKU listed under two products to the lower product key, stably', async () => {
    // The store lists one button under pf_id 198575 and 208708 with the same SKU.
    PRODUCTS.set('9001', fixture('prism-detail-single.html'));
    PRODUCTS.set('8001', fixture('prism-detail-single.html'));
    store.listed = ['211098', '206700', '229', '9001', '8001'];
    try {
      await fullRun();
      await drain();
      const owner = (): unknown => db.rows("SELECT ref_key FROM variants WHERE id = '14033360102'")[0]?.['ref_key'];
      expect(owner()).toBe('8001');
      const created = Number(db.rows("SELECT COUNT(*) AS n FROM changes WHERE variant_id = '14033360102'")[0]?.['n']);
      const sweep = await startRun(env, 'supe-store', 'sweep');
      if (sweep.kind !== 'started') throw new Error('sweep not started');
      await drain();
      expect(owner()).toBe('8001');
      // The repeat read logs nothing new for the shared SKU.
      expect(Number(db.rows("SELECT COUNT(*) AS n FROM changes WHERE variant_id = '14033360102'")[0]?.['n'])).toBe(created);
    } finally {
      PRODUCTS.delete('9001');
      PRODUCTS.delete('8001');
    }
  });

  it('ignores a duplicate finalize message', async () => {
    const id = await fullRun();
    await drain();
    db.db.prepare("UPDATE runs SET status = 'finalizing' WHERE id = ?").run(id);
    await handleMessage(env, { type: 'finalize', runId: id, siteId: 'supe-store' }, 'some-other-message');
    expect(runRow(id)?.['status']).toBe('finalizing');
  });
});
