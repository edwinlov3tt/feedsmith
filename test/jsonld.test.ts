import { describe, expect, it } from 'vitest';
import { isDisallowed, mapAvailability, pageKey, parseRobots, parseSitemap, productNodes, variantsFromJsonLd } from '../src/adapters/jsonld.ts';
import { VariantSchema } from '../src/core/model.ts';
import { fixture, testSite } from './helpers.ts';

const site = testSite({ id: 'generic', baseUrl: 'https://www.example-store.com/', platform: 'jsonld' }, { defaultBrand: null, brandKeywords: [] });

describe('jsonld discovery', () => {
  it('reads sitemaps and Disallow rules for User-agent *', () => {
    const robots = parseRobots(
      ['User-agent: Googlebot', 'Disallow: /only-google', '', 'User-agent: *', 'Disallow: /cart', 'Disallow: /*?sort=', 'Allow: /', 'Sitemap: https://s.example/sitemap.xml'].join('\n'),
    );
    expect(robots.sitemaps).toEqual(['https://s.example/sitemap.xml']);
    expect(robots.disallow).toEqual(['/cart', '/*?sort=']);
    expect(isDisallowed('/cart/items', robots.disallow)).toBe(true);
    expect(isDisallowed('/products/a', robots.disallow)).toBe(false);
  });

  it('parses a product sitemap', () => {
    const map = parseSitemap(fixture('jsonld-sitemap-products.xml'));
    expect(map.childSitemaps).toEqual([]);
    expect(map.urls.length).toBeGreaterThan(3);
    expect(map.urls.some((u) => u.includes('/products/'))).toBe(true);
  });

  it('parses a sitemap index', () => {
    const map = parseSitemap('<sitemapindex><sitemap><loc>https://a/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap></sitemapindex>');
    expect(map.childSitemaps).toEqual(['https://a/sitemap_products_1.xml?from=1&to=2']);
  });

  it('keys pages by path', () => {
    expect(pageKey('https://a.com/products/x/?variant=1#top')).toBe('/products/x');
  });
});

describe('jsonld product reading', () => {
  it('reads a ProductGroup with hasVariant (Everlane)', () => {
    const url = 'https://www.everlane.com/products/mens-transit-chino-slim-graphite';
    const nodes = productNodes(fixture('jsonld-everlane.html'));
    expect(nodes).toHaveLength(1);
    const variants = variantsFromJsonLd(nodes, { key: '/products/mens-transit-chino-slim-graphite', url, category: null, department: null, clearance: false, featured: false }, site, url);
    expect(variants.length).toBeGreaterThan(5);
    const v = variants[0];
    expect(v?.brand).toBe('Everlane');
    expect(v?.groupId).toBeTruthy();
    expect(v?.link).toMatch(/^https:\/\/www\.everlane\.com\/products\/mens-transit-chino-slim-graphite/);
    expect(v?.imageLink).toMatch(/^https:\/\//);
    expect(v?.price.currency).toBe('USD');
    expect(new Set(variants.map((x) => x.id)).size).toBe(variants.length);
    for (const x of variants) expect(() => VariantSchema.parse(x)).not.toThrow();
  });

  it('reads a Product with one offer per size (Chubbies)', () => {
    const url = 'https://www.chubbiesshorts.com/products/the-slate';
    const nodes = productNodes(fixture('jsonld-chubbies.html'));
    const variants = variantsFromJsonLd(nodes, { key: '/products/the-slate', url, category: null, department: null, clearance: false, featured: false }, site, url);
    expect(variants.length).toBeGreaterThan(2);
    expect(variants[0]).toMatchObject({ id: '508017-022', title: 'The Slate', brand: 'Chubbies', price: { amount: '54.99', currency: 'USD' }, size: 'S' });
    expect(variants.every((v) => v.groupId === variants[0]?.groupId)).toBe(true);
    // An empty description falls back to the title, since Meta requires one.
    expect(variants[0]?.description).toBe('The Slate');
  });

  it('maps schema.org availability values', () => {
    expect(mapAvailability('https://schema.org/InStock')).toBe('in stock');
    expect(mapAvailability('http://schema.org/OutOfStock')).toBe('out of stock');
    expect(mapAvailability('PreOrder')).toBe('preorder');
    expect(mapAvailability('schema:BackOrder')).toBe('available for order');
    expect(mapAvailability(null)).toBe('in stock');
  });

  it('ignores pages without product data', () => {
    expect(productNodes('<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>')).toEqual([]);
    expect(productNodes('<script type="application/ld+json">{not json</script>')).toEqual([]);
  });
});
