// Fail-closed checks that need no database: every admin route rejects
// missing or wrong tokens before touching storage.

import { describe, expect, it } from 'vitest';
import { app } from '../src/api/app.ts';

const TOKEN = 'test-admin-token-0123456789abcdef';

// Bindings that throw if used, proving auth runs before any data access.
const untouchable = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      throw new Error(`storage touched: ${String(prop)}`);
    },
  },
);

function env(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ADMIN_TOKEN: TOKEN, TOKEN_ENC_KEY: 'x', USER_AGENT: 'test', META_GRAPH_VERSION: 'v23.0', DB: untouchable, FEEDS: untouchable, CRAWL: untouchable, ...overrides };
}

const ADMIN_ROUTES: Array<[string, string]> = [
  ['GET', '/admin/sites'],
  ['POST', '/admin/sites'],
  ['GET', '/admin/sites/supe-store'],
  ['PATCH', '/admin/sites/supe-store'],
  ['POST', '/admin/sites/supe-store/feed-password'],
  ['PUT', '/admin/sites/supe-store/meta'],
  ['DELETE', '/admin/sites/supe-store/meta'],
  ['POST', '/admin/sites/supe-store/runs'],
  ['GET', '/admin/sites/supe-store/runs'],
  ['GET', '/admin/runs/00000000-0000-4000-8000-000000000000'],
  ['GET', '/admin/runs/00000000-0000-4000-8000-000000000000/meta-status'],
  ['GET', '/admin/sites/supe-store/changes'],
  ['POST', '/admin/sites/supe-store/preview'],
  ['POST', '/admin/clients'],
  ['GET', '/admin/clients'],
  ['GET', '/admin/clients/ua-supply-store'],
  ['PATCH', '/admin/clients/ua-supply-store'],
  ['PUT', '/admin/sites/supe-store/client'],
  ['GET', '/admin/sites/supe-store/product-sets'],
  ['PUT', '/admin/sites/supe-store/product-sets/womens'],
  ['DELETE', '/admin/sites/supe-store/product-sets/womens'],
  ['POST', '/admin/sites/supe-store/product-sets/defaults'],
  ['POST', '/admin/sites/supe-store/product-sets/sync'],
  ['GET', '/admin/sites/supe-store/product-sets/womens/items'],
];

describe('admin API auth', () => {
  it.each(ADMIN_ROUTES)('%s %s without a token is 401', async (method, path) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? null : '{}' }, env());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it.each(ADMIN_ROUTES)('%s %s with a wrong token is 401', async (method, path) => {
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}x` } }, env());
    expect(res.status).toBe(401);
  });

  it('fails closed when ADMIN_TOKEN is not configured', async () => {
    const res = await app.request('/admin/sites', { headers: { authorization: 'Bearer anything' } }, env({ ADMIN_TOKEN: '' }));
    expect(res.status).toBe(503);
  });

  it('rejects oversized admin bodies', async () => {
    const res = await app.request('/admin/sites', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(70 * 1024) }, body: 'x'.repeat(70 * 1024) }, env());
    expect(res.status).toBe(413);
  });
});

describe('public surface', () => {
  it('serves health and the OpenAPI document without auth', async () => {
    expect((await app.request('/health', {}, env())).status).toBe(200);
    const doc = await app.request('/openapi.json', {}, env());
    expect(doc.status).toBe(200);
    const spec: unknown = await doc.json();
    expect(JSON.stringify(spec)).toContain('/admin/sites/{siteId}/runs');
  });

  it('returns 404 JSON for unknown paths instead of a fallback page', async () => {
    const res = await app.request('/anything/else', {}, env());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('asks for Basic auth on a product set feed', async () => {
    const res = await app.request(
      '/feeds/supe-store/sets/womens/meta.csv',
      {},
      env({ DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('asks for Basic auth on the feed', async () => {
    const res = await app.request(
      '/feeds/supe-store/meta.csv',
      {},
      env({ DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });
});
