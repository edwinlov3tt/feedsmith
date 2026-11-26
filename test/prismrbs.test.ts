import { describe, expect, it } from 'vitest';
import { isbnToGtin, labelSingleOptions, mergeListings, parseDepartmentPage, PROMO_CATEGORY, parseListPage, parseNavLinks, parseProductPage, parseVariantScript } from '../src/adapters/prismrbs.ts';
import { prismrbs } from '../src/adapters/prismrbs.ts';
import { HttpClient, siteHosts } from '../src/core/http.ts';
import { VariantSchema, type ProductRef } from '../src/core/model.ts';
import { fixture, testSite } from './helpers.ts';

const BASE = 'https://www.universitysupplystore.com/';
const ref = (key: string): ProductRef => ({ key, url: `${BASE}shop_product_detail.asp?pf_id=${key}&type=1`, category: 'T-Shirts', department: null, clearance: false, featured: false, newItem: false });

describe('prismrbs discovery parsing', () => {
  it('finds category IDs and department pages in the navigation', () => {
    const nav = parseNavLinks(fixture('prism-main.html'), BASE);
    expect(nav.catalogIds.length).toBeGreaterThan(50);
    expect(nav.catalogIds).toContain(454);
    expect(nav.departmentPages.some((p) => p.includes('catalog_group_id=MQ'))).toBe(true);
  });

  it('reads product cards, item count and page count from a category page', () => {
    const page = parseListPage(fixture('prism-list-p1.html'), BASE);
    expect(page.category).toBe('T-Shirts');
    expect(page.pageCount).toBe(3);
    expect(page.totalItems).toBeGreaterThan(120);
    expect(page.products.length).toBe(60);
    const first = page.products[0];
    expect(first?.url).toMatch(/^https:\/\/www\.universitysupplystore\.com\/shop_product_detail\.asp\?pf_id=\d+&type=1$/);
    expect(new Set(page.products.map((p) => p.key)).size).toBe(60);
  });
});

describe('prismrbs departments and merchandising labels', () => {
  it('reads a department page without picking up the global nav', () => {
    const dept = parseDepartmentPage(fixture('prism-department.html'), BASE);
    expect(dept.name).toBe('Bama Merchandise');
    expect(dept.catalogIds).toContain(652); // All Clearance Items
    expect(dept.catalogIds).toContain(443); // Gift Cards
    // The whole page links ~180 categories through its nav; the department lists far fewer.
    expect(dept.catalogIds.length).toBeLessThan(80);
    expect(dept.subGroups.some((g) => g.includes('catalog_group_name='))).toBe(true);
  });

  it('keeps catalog_group_name in department links (without it the store 404s)', () => {
    const nav = parseNavLinks(fixture('prism-main.html'), BASE);
    expect(nav.departmentPages.every((p) => p.includes('catalog_group_name='))).toBe(true);
  });

  it('merges every listing of a product into one ref with labels', () => {
    const r = (key: string) => ({ key, url: `${BASE}shop_product_detail.asp?pf_id=${key}&type=1`, category: null, department: null, clearance: false, featured: false, newItem: false });
    const merged = mergeListings(
      [
        { id: 652, name: 'All Clearance Items', refs: [r('1'), r('2')] },
        { id: 454, name: 'T-Shirts', refs: [r('1')] },
        { id: 515, name: 'Featured Items', refs: [r('1')] },
        { id: 700, name: 'Sweats', refs: [r('3')] },
        { id: 429, name: 'NEW ITEMS', refs: [r('4'), r('5')] },
        { id: 600, name: 'Hats', refs: [r('4')] },
      ],
      new Map([[454, 'Bama Merchandise'], [652, 'Bama Merchandise'], [700, 'Bama Merchandise']]),
    );
    const byKey = new Map(merged.map((m) => [m.key, m]));
    // Listed in clearance, T-Shirts and Featured: T-Shirts is the type, the rest are flags.
    expect(byKey.get('1')).toMatchObject({ category: 'T-Shirts', department: 'Bama Merchandise', clearance: true, featured: true });
    // Only in clearance: that is all we know.
    expect(byKey.get('2')).toMatchObject({ category: 'All Clearance Items', clearance: true, featured: false, newItem: false });
    expect(byKey.get('3')).toMatchObject({ category: 'Sweats', clearance: false });
    // New Items is a promotion even when it is the lowest ID: Hats is the type.
    expect(byKey.get('4')).toMatchObject({ category: 'Hats', newItem: true, featured: false });
    expect(byKey.get('5')).toMatchObject({ category: 'NEW ITEMS', newItem: true });
  });

  it('names a sub-group after its parent department even when the nav links it directly', async () => {
    const dept = (name: string, body: string): string => `<nav><a href="shop_product_list.asp?catalog_id=999">nav noise</a></nav><main><h1><span>${name}</span></h1>${body}</main>`;
    const list = (cat: string, id: string): string =>
      `<h1><span>${cat}</span></h1><span class="paging-page-info">page 1 of 1</span><section class="products-container"><a href="shop_product_detail.asp?pf_id=${id}&type=1">x</a></section>`;
    const pages: Record<string, string> = {
      '/': '<a href="shop_main.asp?catalog_group_id=A&catalog_group_name=QQ">Merch</a><a href="shop_main.asp?catalog_group_id=G&catalog_group_name=Rw">Gift Ideas</a>',
      '/shop_main.asp': '',
      '/shop_main.asp?catalog_group_id=A&catalog_group_name=QQ': dept('Bama Merchandise', '<a href="shop_product_list.asp?catalog_id=1">Tees</a><a href="shop_main.asp?catalog_group_id=G&catalog_group_name=Rw">Gift Ideas</a>'),
      '/shop_main.asp?catalog_group_id=G&catalog_group_name=Rw': dept('Gift Ideas', '<a href="shop_product_list.asp?catalog_id=2">Mugs</a>'),
      '/shop_product_list.asp?catalog_id=1&sort=0': list('Tees', '10'),
      '/shop_product_list.asp?catalog_id=2&sort=0': list('Mugs', '20'),
      '/shop_product_list.asp?catalog_id=999&sort=0': list('Noise', '30'),
    };
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(String(input));
      const body = pages[`${u.pathname}${u.search}`];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    };
    const site = testSite();
    const http = new HttpClient({ allowedHosts: siteHosts(site.baseUrl), userAgent: 't', retries: 0, fetchImpl });
    const result = await prismrbs.discover({ site, http });
    const byKey = new Map(result.refs.map((r) => [r.key, r]));
    expect(byKey.get('10')?.department).toBe('Bama Merchandise');
    expect(byKey.get('20')?.department).toBe('Bama Merchandise');
    expect(byKey.get('20')?.category).toBe('Mugs');
  });

  it('reads a sub-department without its breadcrumb link back to the parent (uwyostore.com)', () => {
    const base = 'https://www.uwyostore.com/';
    const dept = parseDepartmentPage(fixture('prism-uwyo-subdepartment.html'), base);
    expect(dept.name).toBe('Club Sports');
    expect(dept.catalogIds).toHaveLength(22);
    // The breadcrumb links "Apparel" (catalog_group_id=ODE); it is not a sub-group.
    expect(dept.subGroups.some((u) => u.includes('catalog_group_id=ODE&'))).toBe(false);
    expect(dept.breadcrumbs.some((u) => u.includes('catalog_group_id=ODE&'))).toBe(true);
  });

  it('keeps universitysupplystore.com\'s labels: a specific department beats the catch-all page', async () => {
    // The nav links the catch-all "Bama Merchandise", its sub-group "Gift Ideas"
    // (whose breadcrumb links back to it), and "Apparel". Both list category 1.
    const crumb = '<nav aria-label="Breadcrumb"><ol><li><a href="shop_main.asp?catalog_group_id=MQ&catalog_group_name=QmFtYQ">Bama Merchandise</a></li></ol></nav>';
    const dept = (name: string, body: string): string => `<main><h1><span>${name}</span></h1>${body}</main>`;
    const list = (cat: string, id: string): string =>
      `<h1><span>${cat}</span></h1><span class="paging-page-info">page 1 of 1</span><section class="products-container"><a href="shop_product_detail.asp?pf_id=${id}&type=1">x</a></section>`;
    const pages: Record<string, string> = {
      '/': '<a href="shop_main.asp?catalog_group_id=MQ&catalog_group_name=QmFtYQ">m</a><a href="shop_main.asp?catalog_group_id=G&catalog_group_name=Rw">g</a><a href="shop_main.asp?catalog_group_id=AP&catalog_group_name=QXA">a</a>',
      '/shop_main.asp': '',
      '/shop_main.asp?catalog_group_id=MQ&catalog_group_name=QmFtYQ': dept('Bama Merchandise', '<a href="shop_product_list.asp?catalog_id=1">c</a><a href="shop_main.asp?catalog_group_id=G&catalog_group_name=Rw">Gift Ideas</a>'),
      '/shop_main.asp?catalog_group_id=G&catalog_group_name=Rw': dept('Gift Ideas', crumb + '<a href="shop_product_list.asp?catalog_id=2">c</a>'),
      '/shop_main.asp?catalog_group_id=AP&catalog_group_name=QXA': dept('Apparel', '<a href="shop_product_list.asp?catalog_id=1">c</a>'),
      '/shop_product_list.asp?catalog_id=1&sort=0': list('Tees', '10'),
      '/shop_product_list.asp?catalog_id=2&sort=0': list('Mugs', '20'),
    };
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(String(input));
      const body = pages[`${u.pathname}${u.search}`];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    };
    const site = testSite();
    const http = new HttpClient({ allowedHosts: siteHosts(site.baseUrl), userAgent: 't', retries: 0, fetchImpl });
    const result = await prismrbs.discover({ site, http });
    expect(result.refs.find((r) => r.key === '10')?.department).toBe('Apparel');
  });

  it('ignores a sub-group\'s breadcrumb to its parent, and lets a nav department keep its own categories', async () => {
    // Like uwyostore.com: Apparel nests Men and Club Sports, whose breadcrumbs
    // link Apparel, and the nav also links Club Sports on its own.
    const crumb = '<nav aria-label="Breadcrumb" class="breadcrumbs-cont shop"><ol><li><a href="shop_main.asp?catalog_group_id=AP&catalog_group_name=QXBwYXJlbA">Apparel</a></li></ol></nav>';
    const dept = (name: string, body: string): string => `<main><h1><span>${name}</span></h1>${body}</main>`;
    const list = (cat: string, id: string): string =>
      `<h1><span>${cat}</span></h1><span class="paging-page-info">page 1 of 1</span><section class="products-container"><a href="shop_product_detail.asp?pf_id=${id}&type=1">x</a></section>`;
    const link = (id: string, name: string): string => `<a href="shop_main.asp?catalog_group_id=${id}&catalog_group_name=${name}">g</a>`;
    const cat = (id: number): string => `<a href="shop_product_list.asp?catalog_id=${id}">c</a>`;
    const pages: Record<string, string> = {
      '/': link('AP', 'QXBwYXJlbA') + link('CS', 'Q2x1Yg'),
      '/shop_main.asp': '',
      '/shop_main.asp?catalog_group_id=AP&catalog_group_name=QXBwYXJlbA': dept('Apparel', cat(1) + link('MN', 'TWVu') + link('AC', 'QUM')),
      '/shop_main.asp?catalog_group_id=MN&catalog_group_name=TWVu': dept('Men', crumb + cat(2)),
      '/shop_main.asp?catalog_group_id=AC&catalog_group_name=QUM': dept('Club Sports', crumb + cat(3)),
      '/shop_main.asp?catalog_group_id=CS&catalog_group_name=Q2x1Yg': dept('Club Sports', cat(3)),
      '/shop_product_list.asp?catalog_id=1&sort=0': list('Youth', '10'),
      '/shop_product_list.asp?catalog_id=2&sort=0': list("Men's Tees", '20'),
      '/shop_product_list.asp?catalog_id=3&sort=0': list('Rugby', '30'),
    };
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(String(input));
      const body = pages[`${u.pathname}${u.search}`];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    };
    const site = testSite();
    const http = new HttpClient({ allowedHosts: siteHosts(site.baseUrl), userAgent: 't', retries: 0, fetchImpl });
    const result = await prismrbs.discover({ site, http });
    const byKey = new Map(result.refs.map((r) => [r.key, r.department]));
    expect(Object.fromEntries(byKey)).toEqual({ '10': 'Apparel', '20': 'Apparel', '30': 'Club Sports' });
  });

  it('recognizes promotional category names', () => {
    for (const n of ['All Clearance Items', 'SALE ITEMS - All Sales Final', 'Featured Items', 'New Arrivals', 'Gift Ideas']) expect(PROMO_CATEGORY.test(n), n).toBe(true);
    for (const n of ['T-Shirts', 'Caps, Hats, & Beanies', 'Salem Collection', 'Wholesale Pens']) expect(PROMO_CATEGORY.test(n), n).toBe(false);
  });
});

describe('prismrbs product parsing', () => {
  it('reads every variant with its own SKU, price and labeled options', () => {
    const items = parseVariantScript(fixture('prism-detail-multi.html'));
    expect(items).not.toBeNull();
    expect(items?.length).toBe(6);
    expect(items?.[0]).toEqual({
      available: true,
      itemNumber: '14342103102',
      price: '$30.00',
      attributes: { Color: 'IVORY COMFORT COLOR', Size: 'SM UNISEX' },
      lowStock: null,
    });
    expect(items?.[5]?.price).toBe('$35.00');
  });

  it('maps a multi-variant page to feed-ready variants', () => {
    const result = parseProductPage(fixture('prism-detail-multi.html'), ref('211098'), testSite());
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.variants).toHaveLength(6);
    const v = result.variants[4];
    expect(v).toMatchObject({
      id: '14342141102',
      groupId: '211098',
      title: 'Tide Together T-Shirt 2026',
      price: { amount: '32.00', currency: 'USD' },
      availability: 'in stock',
      size: '2XL',
      gender: 'unisex',
      ageGroup: 'adult',
      color: 'IVORY COMFORT COLOR',
      imageLink: `${BASE}outerweb/product_images/14342103L.png`,
      productType: 'T-Shirts',
    });
    expect(v?.additionalImageLinks).toEqual([`${BASE}outerweb/product_images/14342103L1.png`]);
    expect(v?.description).toMatch(/^Show Your Pride/);
    expect(v?.description).not.toMatch(/<|Product Description/);
    for (const x of result.variants) expect(() => VariantSchema.parse(x)).not.toThrow();
  });

  it('reads a single-SKU product from the hidden input', () => {
    const result = parseProductPage(fixture('prism-detail-single.html'), ref('206700'), testSite());
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({
      id: '14033360102',
      title: 'Alabama Crimson Tide Big Logo Tee',
      price: { amount: '19.99' },
      availability: 'in stock',
      size: 'S',
      gender: 'male',
      ageGroup: 'adult',
      color: 'CRIMSON',
    });
  });

  it('reads a single SKU whose add-to-cart button has no id (uwyostore.com)', () => {
    const base = 'https://www.uwyostore.com/';
    const site = testSite({ baseUrl: base });
    const uref: ProductRef = { key: '72230', url: `${base}shop_product_detail.asp?pf_id=72230&type=1`, category: 'Hats', department: null, clearance: false, featured: false, newItem: false };
    const html = fixture('prism-uwyo-single.html');
    const result = parseProductPage(html, uref, site);
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.variants[0]).toMatchObject({ id: '145020641581', title: '47® Wyoming Patch on Cow Print Hat', price: { amount: '42.00' }, availability: 'in stock', imageLink: `${base}outerweb/product_images/14502064l.png` });
    // A disabled button still means it can't be bought.
    const disabled = html.replace('name="addcart" value="Add to Cart" class="button primary"/>', 'name="addcart" value="Add to Cart" class="button primary" disabled="true"/>');
    const sold = parseProductPage(disabled, uref, site);
    expect(sold.kind === 'ok' && sold.variants[0]?.availability).toBe('out of stock');
  });

  it('treats the "image not available" placeholder as no image', () => {
    const base = 'https://www.uwyostore.com/';
    const uref: ProductRef = { key: '72230', url: `${base}shop_product_detail.asp?pf_id=72230&type=1`, category: null, department: null, clearance: false, featured: false, newItem: false };
    const html = fixture('prism-uwyo-single.html').replace('value="outerweb/product_images/14502064l.png"', 'value="outerweb/product_images/not_available_large.webp"');
    const withExtra = parseProductPage(html, uref, testSite({ baseUrl: base }));
    // The first additional photo is promoted.
    expect(withExtra.kind === 'ok' && withExtra.variants[0]?.imageLink).toBe(`${base}outerweb/product_images/14502064l1.png`);
    const none = parseProductPage(html.replace(/<a[^>]*id="additional_product_url-\d+"[^>]*>/g, ''), uref, testSite({ baseUrl: base }));
    expect(none.kind === 'ok' && none.variants[0]?.imageLink).toBeNull();
  });

  it('reads a book page, whose SKU input has no id, with its ISBN as GTIN', () => {
    const result = parseProductPage(fixture('prism-detail-type3.html'), { key: '229', url: `${BASE}shop_product_detail.asp?pf_id=229&type=3`, category: null, department: null, clearance: false, featured: false, newItem: false }, testSite());
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.variants[0]).toMatchObject({ id: '10881859101', title: 'Biology 2 Study Aid', price: { amount: '6.95' }, gtin: '9781572228269', attributes: {}, color: null });
  });

  it('converts ISBN-10 to ISBN-13', () => {
    expect(isbnToGtin('1572228261')).toBe('9781572228269');
    expect(isbnToGtin('0-306-40615-2')).toBe('9780306406157');
    expect(isbnToGtin('9780306406157')).toBe('9780306406157');
    expect(isbnToGtin('12345')).toBeNull();
  });

  it('reports a removed product as gone, not as an error', () => {
    expect(parseProductPage(fixture('prism-detail-missing.html'), ref('999999991'), testSite()).kind).toBe('gone');
  });

  it('treats an unrecognized page as an error so it never marks stock out', () => {
    expect(parseProductPage('<html><body>maintenance</body></html>', ref('1'), testSite()).kind).toBe('error');
  });

  it('works unchanged on another PrismRBS store', () => {
    const site = testSite({ baseUrl: 'https://bookstore.illinois.edu/' });
    const result = parseProductPage(fixture('prism-illinois-detail.html'), { key: '1', url: 'https://bookstore.illinois.edu/shop_product_detail.asp?pf_id=1&type=1', category: null, department: null, clearance: false, featured: false, newItem: false }, site);
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.variants.length).toBeGreaterThanOrEqual(2);
    expect(result.variants.every((v) => /^\d{10,}$/.test(v.id))).toBe(true);
    expect(result.variants.every((v) => v.size !== null)).toBe(true);
  });

  it('repairs the "buttons":] markup PrismRBS emits for products without options', () => {
    const html = `<script>itemList={"items": [ {"available":true,"itemNumber":"13879983","price":"$32.00","availability": "In stock","buttons":]}, {"available":true,"itemNumber":"1371400042","price":"$22.00","availability": "In stock.<div class='low-inventory-message'>Buy Now! Only 3 left.</div>","buttons":]} ] } psObj = new ProductSelector(itemList );</script>`;
    expect(parseVariantScript(html)).toEqual([
      { available: true, itemNumber: '13879983', price: '$32.00', attributes: {}, lowStock: null },
      { available: true, itemNumber: '1371400042', price: '$22.00', attributes: {}, lowStock: 3 },
    ]);
  });

  it('labels unnamed single-SKU options by guessing the size', () => {
    expect(labelSingleOptions("CRIMSON,SM MEN'S")).toEqual({ Color: 'CRIMSON', Size: "SM MEN'S" });
    expect(labelSingleOptions('2XL,NAVY')).toEqual({ Size: '2XL', Color: 'NAVY' });
    expect(labelSingleOptions('')).toEqual({});
  });

  it('detects the platform from a homepage', () => {
    expect(prismrbs.detect(fixture('prism-home.html'))).toBe(true);
    expect(prismrbs.detect(fixture('jsonld-chubbies.html'))).toBe(false);
  });
});
