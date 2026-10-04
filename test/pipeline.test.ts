import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, safeEqual } from '../src/core/crypto.ts';
import { HttpClient, parsePublicHttpsUrl, siteHosts } from '../src/core/http.ts';
import { VariantSchema } from '../src/core/model.ts';
import { batchRequests, checkBatchStatus, pushVariants, upsertProductSet } from '../src/pipeline/meta.ts';
import { compareKeys, evaluateGates } from '../src/pipeline/run.ts';
import { testSite } from './helpers.ts';

const variant = VariantSchema.parse({
  id: '14342103102',
  groupId: '211098',
  title: 'Tide Together T-Shirt 2026',
  description: 'Shirt',
  link: 'https://www.universitysupplystore.com/shop_product_detail.asp?pf_id=211098&type=1',
  imageLink: 'https://www.universitysupplystore.com/outerweb/product_images/14342103L.png',
  additionalImageLinks: [],
  brand: 'University of Alabama Supply Store',
  price: { amount: '30.00', currency: 'USD' },
  salePrice: null,
  availability: 'in stock',
  attributes: { Size: 'SM UNISEX' },
  size: 'S',
  color: null,
  gender: 'unisex',
  ageGroup: 'adult',
  gtin: null,
  mpn: null,
  productType: 'T-Shirts',
  lowStockHint: null,
});

describe('publish gates', () => {
  const site = testSite({ lastDiscoveryCount: 2000 });
  const healthy = { soldOut: 0, sellableBefore: 5000 };
  it('passes a healthy run', () => {
    expect(evaluateGates({ run: { mode: 'full', total: 2000, discovered: 1990 }, counts: { error: 10, gone: 5, processed: 2000 }, ...healthy }, site).passed).toBe(true);
  });
  it('rejects a run with too many unreadable pages', () => {
    const g = evaluateGates({ run: { mode: 'sweep', total: 1000, discovered: null }, counts: { error: 300, gone: 0, processed: 1000 }, ...healthy }, site);
    expect(g.passed).toBe(false);
    expect(g.reasons[0]).toMatch(/error rate 30\.0%/);
  });
  it('rejects a full run that found far fewer products than last time', () => {
    const g = evaluateGates({ run: { mode: 'full', total: 900, discovered: 900 }, counts: { error: 0, gone: 0, processed: 900 }, ...healthy }, site);
    expect(g.passed).toBe(false);
    expect(g.reasons[0]).toMatch(/discovered 900 products, 45%/);
  });
  it('rejects a sweep where the site suddenly reports most products gone (site-wide 404)', () => {
    const g = evaluateGates({ run: { mode: 'sweep', total: 2000, discovered: null }, counts: { error: 0, gone: 1900, processed: 2000 }, ...healthy }, site);
    expect(g.passed).toBe(false);
    expect(g.reasons[0]).toMatch(/reported gone/);
  });
  it('rejects a run that sells out an implausible share of variants at once', () => {
    const g = evaluateGates({ run: { mode: 'sweep', total: 2000, discovered: null }, counts: { error: 0, gone: 0, processed: 2000 }, soldOut: 3000, sellableBefore: 5000 }, site);
    expect(g.passed).toBe(false);
    expect(g.reasons[0]).toMatch(/sold out in one run/);
  });
  it('does not apply the discovery gate to the first run', () => {
    expect(evaluateGates({ run: { mode: 'full', total: 10, discovered: 10 }, counts: { error: 0, gone: 0, processed: 10 }, ...healthy }, testSite()).passed).toBe(true);
  });
});

describe('product key order', () => {
  it('compares numeric keys as numbers and paths as text', () => {
    expect(compareKeys('9', '10')).toBeLessThan(0);
    expect(compareKeys('198575', '208708')).toBeLessThan(0);
    expect(compareKeys('/products/b', '/products/a')).toBeGreaterThan(0);
    expect(compareKeys('5', '5')).toBe(0);
  });
});

describe('meta batch payload', () => {
  it('builds a PRODUCT_ITEM per Meta\'s field reference', () => {
    const [req] = batchRequests([{ ...variant, additionalImageLinks: ['https://x/2.png'] }]);
    expect(req).toEqual({
      method: 'UPDATE',
      data: {
        id: '14342103102',
        title: 'Tide Together T-Shirt 2026',
        description: 'Shirt',
        availability: 'in stock',
        condition: 'new',
        price: '30.00 USD',
        link: variant.link,
        image: [{ url: variant.imageLink }, { url: 'https://x/2.png' }],
        brand: 'University of Alabama Supply Store',
        item_group_id: '211098',
        size: 'S',
        gender: 'unisex',
        age_group: 'adult',
        product_type: 'T-Shirts',
        custom_label_2: '$25-$50',
      },
    });
  });

  it('applies the Batch API limits, which are tighter than the CSV\'s', () => {
    const [req] = batchRequests([{ ...variant, title: 'T'.repeat(180), description: 'word '.repeat(1500), availability: 'preorder' }]);
    expect(String(req?.data['title']).length).toBeLessThanOrEqual(100);
    expect(String(req?.data['description']).length).toBeLessThanOrEqual(5000);
    expect(req?.data['availability']).toBe('available for order');
  });

  it('collects per-item rejections from validation_status', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ handles: ['h1'], validation_status: [{ retailer_id: '14342103102', errors: [{ message: 'Invalid price' }], warnings: [{ message: 'w' }] }] }), { status: 200 });
    const result = await pushVariants({ catalogId: '123456789', token: 't', graphVersion: 'v23.0' }, [variant], fakeFetch);
    expect(result.rejected).toEqual([{ id: '14342103102', message: 'Invalid price' }]);
    expect(result.warnings).toBe(1);
  });

  it('reads check_batch_request_status, with the token in the header', async () => {
    let url = '';
    let auth: string | null = null;
    const fakeFetch: typeof fetch = async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ data: [{ handle: 'h1', status: 'finished', errors_total_count: 1, errors: [{ id: 'sku1', message: 'bad image' }], ids_of_invalid_requests: ['sku1'] }] }), { status: 200 });
    };
    const status = await checkBatchStatus({ catalogId: '123456789', token: 'tok', graphVersion: 'v23.0' }, 'h1', fakeFetch);
    expect(status).toEqual({ handle: 'h1', status: 'finished', errorsTotal: 1, errors: [{ id: 'sku1', message: 'bad image' }], invalidIds: ['sku1'] });
    expect(url).toContain('/123456789/check_batch_request_status?handle=h1');
    expect(url).not.toContain('tok');
    expect(auth).toBe('Bearer tok');
  });

  it('puts the token in the Authorization header, not the URL', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ handles: ['h1'] }), { status: 200 });
    };
    const result = await pushVariants({ catalogId: '123456789', token: 'secret-token-value', graphVersion: 'v23.0' }, [variant], fakeFetch);
    expect(result).toEqual({ sent: 1, handles: ['h1'], rejected: [], warnings: 0 });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v23.0/123456789/items_batch');
    expect(calls[0]?.url).not.toContain('secret');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret-token-value');
  });

  it('throws on a Graph API error so changes stay unpushed', async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 401 });
    await expect(pushVariants({ catalogId: '123456789', token: 't', graphVersion: 'v23.0' }, [variant], fakeFetch)).rejects.toThrow(/Invalid OAuth/);
  });

  it('refuses a non-numeric catalog ID instead of building a URL from it', async () => {
    await expect(pushVariants({ catalogId: '123/../../me', token: 't', graphVersion: 'v23.0' }, [variant], async () => new Response('{}'))).rejects.toThrow();
  });
});

describe('meta product sets', () => {
  const target = { catalogId: '123456789', token: 'tok', graphVersion: 'v23.0' };
  const set = { slug: 'womens', name: "Women's", filter: { gender: { eq: 'female' } } };

  function fakeMeta(existingId: string | null) {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : '' });
      if (url.includes('/product_sets?')) return new Response(JSON.stringify({ data: existingId ? [{ id: existingId, retailer_id: 'feedsmith:womens' }] : [] }));
      if (url.endsWith('/product_sets')) return new Response(JSON.stringify({ id: '555000111' }));
      return new Response(JSON.stringify({ success: true }));
    };
    return { calls, fetchImpl };
  }

  it('creates a new set tagged with retailer_id feedsmith:<slug>', async () => {
    const { calls, fetchImpl } = fakeMeta(null);
    expect(await upsertProductSet(target, { ...set, metaSetId: null }, fetchImpl)).toEqual({ metaSetId: '555000111', action: 'created' });
    const create = calls.find((c) => c.method === 'POST');
    const form = new URLSearchParams(create?.body);
    expect(create?.url).toBe('https://graph.facebook.com/v23.0/123456789/product_sets');
    expect(form.get('retailer_id')).toBe('feedsmith:womens');
    expect(JSON.parse(form.get('filter') ?? '')).toEqual({ gender: { eq: 'female' } });
  });

  it('re-finds a set Feedsmith made earlier instead of duplicating it', async () => {
    const { calls, fetchImpl } = fakeMeta('777000222');
    expect(await upsertProductSet(target, { ...set, metaSetId: null }, fetchImpl)).toEqual({ metaSetId: '777000222', action: 'adopted' });
    expect(calls.some((c) => c.url.endsWith('/product_sets') && c.method === 'POST')).toBe(false);
    expect(calls.at(-1)?.url).toBe('https://graph.facebook.com/v23.0/777000222');
  });

  it('links to a hand-made set with the same filter when Meta reports a duplicate (10803)', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('retailer_id=')) return new Response(JSON.stringify({ data: [] }));
      if (url.includes('fields=id%2Cname%2Cfilter')) {
        return new Response(JSON.stringify({ data: [{ id: '111', filter: '{"gender":{"eq":"male"}}' }, { id: '999000444', filter: '{"gender":{"eq":"Female"}}' }] }));
      }
      if (init?.method === 'POST') return new Response(JSON.stringify({ error: { message: 'Product set with the same filters already exists', code: 10803 } }), { status: 400 });
      return new Response('{}');
    };
    expect(await upsertProductSet(target, { ...set, metaSetId: null }, fetchImpl)).toEqual({ metaSetId: '999000444', action: 'adopted' });
  });

  it('updates a set it already knows', async () => {
    const { calls, fetchImpl } = fakeMeta(null);
    expect(await upsertProductSet(target, { ...set, metaSetId: '888000333' }, fetchImpl)).toEqual({ metaSetId: '888000333', action: 'updated' });
    expect(calls).toHaveLength(1);
  });
});

describe('secrets', () => {
  it('round-trips an encrypted token and fails with the wrong key', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const blob = await encryptSecret('EAAB-token', key);
    expect(blob).not.toContain('EAAB');
    expect(await decryptSecret(blob, key)).toBe('EAAB-token');
    await expect(decryptSecret(blob, other)).rejects.toThrow();
  });

  it('compares secrets exactly and never matches empty', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('', '')).toBe(false);
  });
});

describe('outbound URL policy', () => {
  it('accepts only public https hostnames', () => {
    expect(parsePublicHttpsUrl('https://www.universitysupplystore.com/')).not.toBeNull();
    for (const bad of ['http://store.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://user:pw@store.com/', 'https://intranet/', 'ftp://store.com/', 'https://x.internal/']) {
      expect(parsePublicHttpsUrl(bad), bad).toBeNull();
    }
  });

  it('refuses redirects that leave the site', async () => {
    const fakeFetch: typeof fetch = async (input) =>
      String(input).includes('store.com') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }) : new Response('evil');
    const http = new HttpClient({ allowedHosts: siteHosts('https://store.com/'), userAgent: 't', retries: 0, fetchImpl: fakeFetch });
    const res = await http.getText('https://store.com/page');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/host not allowed: evil\.example/);
  });

  it('follows redirects between www and apex', async () => {
    const fakeFetch: typeof fetch = async (input) =>
      String(input).startsWith('https://store.com/') ? new Response(null, { status: 301, headers: { location: 'https://www.store.com/page' } }) : new Response('ok', { status: 200 });
    const http = new HttpClient({ allowedHosts: siteHosts('https://store.com/'), userAgent: 't', retries: 0, fetchImpl: fakeFetch });
    const res = await http.getText('https://store.com/page');
    expect(res.ok && res.text).toBe('ok');
  });

  it('stops reading responses over the size cap', async () => {
    const fakeFetch: typeof fetch = async () => new Response('x'.repeat(5000));
    const http = new HttpClient({ allowedHosts: siteHosts('https://store.com/'), userAgent: 't', retries: 0, maxBytes: 1000, fetchImpl: fakeFetch });
    const res = await http.getText('https://store.com/');
    expect(res.ok).toBe(false);
  });
});
