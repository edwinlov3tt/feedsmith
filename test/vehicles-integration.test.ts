// The real pipeline on a stubbed DealerOn dealer site: discovery saves the
// dealership, reads produce vehicles, the feed is Meta's automotive format, a
// sold car (404) becomes not_available, and vehicle sets come from the feed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/api/app.ts';
import { handleDeadLetter, handleMessage, startRun } from '../src/pipeline/run.ts';
import { getSite, insertSite } from '../src/pipeline/store.ts';
import { D1Shim, QueueShim, R2Shim } from './d1-shim.ts';
import { fixture, testSite } from './helpers.ts';

const BASE = 'https://www.northstarfordduluth.com/';
const ADMIN = 'vehicles-admin-token-0123456789';
const USED_VIN = '1FM5K8D88FGC65422';
const NEW_VIN = '3FMCR9BN6TRF07128';

function srp(entries: Array<{ vin: string; path: string }>): string {
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: entries.map((e, i) => ({ '@type': 'ListItem', position: i + 1, url: `${BASE}${e.path}`, identifier: e.vin })) };
  return `<script type="application/ld+json">${JSON.stringify(list)}</script>`;
}

let sold = false;
let db: D1Shim;
let queue: QueueShim;
let r2: R2Shim;
let env: Env;

beforeEach(async () => {
  sold = false;
  db = new D1Shim();
  queue = new QueueShim();
  r2 = new R2Shim();
  // Test doubles implement only the binding methods the pipeline calls.
  env = { DB: db, CRAWL: queue, FEEDS: r2, USER_AGENT: 'test', META_GRAPH_VERSION: 'v23.0', ADMIN_TOKEN: ADMIN, TOKEN_ENC_KEY: 'x' } as unknown as Env;
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const pt = url.searchParams.get('pt');
    if (path === '/') return new Response(fixture('dealeron-home.html'));
    // Like DealerOn: the page past the last one is a 404.
    if (path === '/searchnew.aspx') return pt ? new Response('Page Not Found', { status: 404 }) : new Response(srp([{ vin: NEW_VIN, path: `new-Duluth-2026-Ford-Bronco+Sport-Big+Bend-${NEW_VIN}` }]));
    if (path === '/searchused.aspx') return new Response(pt ? '' : srp(sold ? [] : [{ vin: USED_VIN, path: `used-Duluth-2015-Ford-Explorer-XLT-${USED_VIN}` }]));
    if (path.endsWith(NEW_VIN)) return new Response(fixture('dealeron-vdp-new.html'));
    if (path.endsWith(USED_VIN)) return sold ? new Response('Page Not Found', { status: 404 }) : new Response(fixture('dealeron-vdp-used.html'));
    return new Response('not found', { status: 404 });
  });
  // Two cars: one selling is 50% "gone", over the 30% vehicle default, so the
  // gate is loosened for this tiny lot (a real 280-car lot sells ~1% per sweep).
  await insertSite(db as unknown as D1Database, testSite({ id: 'northstar-ford', name: 'NorthStar Ford', baseUrl: BASE, platform: 'dealeron' }, { defaultBrand: null, brandKeywords: [], maxGoneRate: 0.6, maxSoldOutRate: 0.6, minFeedRatio: 0.4 }), 'hash');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function drain(): Promise<void> {
  for (let guard = 0; queue.messages.length > 0 && guard < 200; guard++) {
    const msg = queue.messages.shift();
    if (!msg) break;
    try {
      await handleMessage(env, msg.body, msg.id);
    } catch {
      if (msg.attempts >= 3) await handleDeadLetter(env, msg.body);
      else queue.messages.push({ ...msg, attempts: msg.attempts + 1 });
    }
  }
}

function feedRows(): Array<Record<string, string>> {
  const text = r2.objects.get('feeds/northstar-ford/meta.csv') ?? '';
  const [header, ...lines] = text.split('\r\n').filter(Boolean);
  const cols = (header ?? '').split(',');
  // Descriptions contain commas; only check rows by their leading columns.
  return lines.map((l) => Object.fromEntries(cols.slice(0, 1).map((c, i) => [c, l.split(',')[i] ?? ''])));
}

describe('vehicles pipeline', () => {
  it('crawls a dealer, publishes an automotive feed, and handles a sold car', async () => {
    const run = await startRun(env, 'northstar-ford', 'full');
    expect(run.kind).toBe('started');
    await drain();
    const notes = JSON.parse(String(db.rows('SELECT notes_json FROM runs WHERE id = ?', run.kind === 'started' ? run.run.id : '')[0]?.['notes_json'] ?? '{}'));
    expect(notes.discoveryTruncated).toBe(false);
    const site = await getSite(db as unknown as D1Database, 'northstar-ford');
    expect(site?.config.dealer).toMatchObject({ name: 'NorthStar Ford MN', city: 'Duluth', region: 'MN' });

    const feed = r2.objects.get('feeds/northstar-ford/meta.csv') ?? '';
    expect(feed.startsWith('vehicle_id,title,description,url,make,model,year,mileage.value,mileage.unit')).toBe(true);
    expect(feedRows().map((r) => r['vehicle_id']).sort()).toEqual([NEW_VIN, USED_VIN].sort());
    expect(feed).toContain(',available,');

    // Recommended vehicle sets from what's in the feed.
    const res = await app.request('/admin/sites/northstar-ford/product-sets/defaults', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } }, env);
    const body = (await res.json()) as { created: string[] };
    expect(body.created).toEqual(['all-available', 'new', 'used', 'suvs']);
    const list = await app.request('/admin/sites/northstar-ford/product-sets', { headers: { authorization: `Bearer ${ADMIN}` } }, env);
    const sets = ((await list.json()) as { sets: Array<{ slug: string; items: number }> }).sets;
    expect(Object.fromEntries(sets.map((s) => [s.slug, s.items]))).toEqual({ 'all-available': 2, new: 1, used: 1, suvs: 2 });

    // The used Explorer sells: its page 404s, and the next sweep marks it not_available.
    sold = true;
    const sweep = await startRun(env, 'northstar-ford', 'sweep');
    expect(sweep.kind).toBe('started');
    await drain();
    const after = r2.objects.get('feeds/northstar-ford/meta.csv') ?? '';
    const usedLine = after.split('\r\n').find((l) => l.startsWith(USED_VIN)) ?? '';
    expect(usedLine).toContain(',not_available,');
    expect(db.rows("SELECT kind FROM changes WHERE variant_id = ? ORDER BY id DESC LIMIT 1", USED_VIN)[0]?.['kind']).toBe('out_of_stock');
  });
});
