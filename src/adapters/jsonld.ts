// Generic storefront adapter: finds pages through robots.txt and sitemaps and
// reads schema.org Product / ProductGroup JSON-LD. Covers most SEO-minded
// stores (Shopify themes, many WooCommerce/BigCommerce/custom sites) with no
// per-site code. Sites without JSON-LD need a dedicated adapter.

import { absoluteUrl, decodeEntities, htmlToText, jsonLdBlocks, parsePrice } from '../core/html.ts';
import { asArray, asRecord, field, hasType, str, type JsonRecord } from '../core/json.ts';
import type { Availability, DiscoverResult, ProductRef, ReadResult, Variant } from '../core/model.ts';
import { apparelSizing, pickBrand, truncate } from '../core/normalize.ts';
import { compilePatterns, type Site } from '../core/site.ts';
import type { Adapter, AdapterContext } from './types.ts';

const MAX_SITEMAP_FILES = 60;

// ---------- discovery ----------

export interface RobotsRules {
  sitemaps: string[];
  disallow: string[];
}

/** The `User-agent: *` group's Disallow rules plus every Sitemap line. */
export function parseRobots(text: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let inStar = false;
  let sawRule = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (key === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (sawRule) inStar = false;
      sawRule = false;
      if (value === '*') inStar = true;
    } else if (key === 'disallow' || key === 'allow') {
      sawRule = true;
      if (inStar && key === 'disallow' && value) disallow.push(value);
    }
  }
  return { sitemaps, disallow };
}

/** robots.txt path match: `*` matches any run, a trailing `$` anchors the end. */
export function robotsRuleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$');
  const pattern = anchored ? rule.slice(0, -1) : rule;
  // Greedy wildcard match with single backtrack point: O(len(path) * stars), no regex.
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = s;
    } else if (p < pattern.length && pattern[p] === path[s]) {
      p++;
      s++;
    } else if (!anchored && p === pattern.length) {
      return true; // prefix match
    } else if (star >= 0) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function isDisallowed(path: string, disallow: readonly string[]): boolean {
  return disallow.some((rule) => robotsRuleMatches(rule, path));
}

export interface Sitemap {
  childSitemaps: string[];
  urls: string[];
}

export function parseSitemap(xml: string): Sitemap {
  const locs = (block: string): string[] =>
    [...block.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities((m[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()));
  if (/<sitemapindex\b/i.test(xml)) {
    return { childSitemaps: [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)].flatMap((m) => locs(m[1] ?? '')), urls: [] };
  }
  return { childSitemaps: [], urls: [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].flatMap((m) => locs(m[1] ?? '').slice(0, 1)) };
}

/** Stable key for a product page: its path, without query or fragment. */
export function pageKey(url: string): string {
  const u = new URL(url);
  return u.pathname.replace(/\/+$/, '') || '/';
}

// ---------- JSON-LD reading ----------

function flattenGraph(node: unknown, out: JsonRecord[], depth = 0): void {
  if (depth > 4) return;
  for (const item of asArray(node)) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec['@graph'] !== undefined) flattenGraph(rec['@graph'], out, depth + 1);
    out.push(rec);
  }
}

export function productNodes(html: string): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  for (const block of jsonLdBlocks(html)) {
    let parsed: unknown;
    try {
      // Some themes leave raw control characters in strings; JSON forbids them.
      parsed = JSON.parse(block.replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      continue;
    }
    flattenGraph(parsed, nodes);
  }
  const groups = nodes.filter((n) => hasType(n, 'ProductGroup'));
  return groups.length ? groups : nodes.filter((n) => hasType(n, 'Product'));
}

const AVAILABILITY: Record<string, Availability> = {
  instock: 'in stock',
  limitedavailability: 'in stock',
  onlineonly: 'in stock',
  instoreonly: 'in stock',
  outofstock: 'out of stock',
  soldout: 'out of stock',
  discontinued: 'discontinued',
  preorder: 'preorder',
  presale: 'preorder',
  backorder: 'available for order',
  madetoorder: 'available for order',
};

export function mapAvailability(raw: string | null): Availability {
  if (!raw) return 'in stock';
  const key = raw.replace(/^.*[/:]/, '').toLowerCase();
  return AVAILABILITY[key] ?? 'out of stock';
}

function images(v: unknown, base: string): string[] {
  const out: string[] = [];
  for (const item of asArray(v)) {
    const url = typeof item === 'string' ? item : field(asRecord(item), 'url') ?? field(asRecord(item), 'contentUrl');
    const abs = url ? absoluteUrl(url, base) : null;
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

function brandOf(v: unknown): string | null {
  return str(v) ?? field(asRecord(asArray(v)[0]), 'name');
}

function gtinOf(rec: JsonRecord): string | null {
  for (const k of ['gtin', 'gtin14', 'gtin13', 'gtin12', 'gtin8', 'isbn']) {
    const v = field(rec, k);
    if (v && /^\d{8,14}$/.test(v.replace(/[-\s]/g, ''))) return v.replace(/[-\s]/g, '');
  }
  return null;
}

interface OfferInfo {
  price: string;
  currency: string | null;
  availability: Availability;
  url: string | null;
  sku: string | null;
}

function offerInfo(offer: JsonRecord): OfferInfo | null {
  const spec = asRecord(asArray(offer['priceSpecification'])[0]);
  const raw = field(offer, 'price') ?? field(offer, 'lowPrice') ?? field(spec, 'price');
  const price = raw ? parsePrice(raw) : null;
  if (!price) return null;
  return {
    price,
    currency: (field(offer, 'priceCurrency') ?? field(spec, 'priceCurrency'))?.toUpperCase() ?? null,
    availability: mapAvailability(field(offer, 'availability')),
    url: field(offer, 'url'),
    sku: field(offer, 'sku'),
  };
}

function offersOf(rec: JsonRecord): JsonRecord[] {
  return asArray(rec['offers'])
    .map(asRecord)
    .filter((o): o is JsonRecord => o !== null)
    .flatMap((o) => (hasType(o, 'AggregateOffer') && o['offers'] !== undefined ? asArray(o['offers']).map(asRecord).filter((x): x is JsonRecord => x !== null) : [o]));
}

/** Variant options encoded in an offer URL, e.g. ?Size=S&Color=Blue. */
function queryAttributes(url: string | null, base: string): Record<string, string> {
  if (!url) return {};
  const abs = absoluteUrl(url, base);
  if (!abs) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(abs).searchParams) {
    if (!/^(variant|_pos|_sid|_ss|utm_.*)$/i.test(k) && v) out[k] = v;
  }
  return out;
}

export function variantsFromJsonLd(nodes: JsonRecord[], ref: ProductRef, site: Site, pageUrl: string): Variant[] {
  const out: Variant[] = [];
  const seen = new Set<string>();
  const fallbackCurrency = site.config.currency;

  for (const node of nodes) {
    const groupName = field(node, 'name') ? decodeEntities(field(node, 'name') ?? '') : null;
    if (!groupName) continue;
    const groupId = field(node, 'productGroupID') ?? field(node, 'sku') ?? field(node, 'productID') ?? ref.key;
    const groupDesc = htmlToText(field(node, 'description') ?? '');
    const groupImages = images(node['image'], pageUrl);
    const groupBrand = brandOf(node['brand']);
    const category = field(node, 'category') ?? ref.category;

    // ProductGroup: one Product per variant. Product: either one offer, or one
    // offer per variant (common on Shopify themes).
    const members = hasType(node, 'ProductGroup')
      ? asArray(node['hasVariant']).map(asRecord).filter((v): v is JsonRecord => v !== null)
      : [node];

    for (const member of members) {
      const offers = offersOf(member);
      const perOffer = members.length === 1 && offers.length > 1;
      const chosen: Array<JsonRecord | null> = perOffer ? offers : [offers[0] ?? null];
      for (const offer of chosen) {
        const info = offer ? offerInfo(offer) : null;
        if (!info) continue;
        const id = (perOffer ? info.sku : null) ?? field(member, 'sku') ?? info.sku ?? field(member, 'productID') ?? field(member, 'mpn') ?? (members.length === 1 ? groupId : null);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const memberImages = images(member['image'], pageUrl);
        const allImages = memberImages.length ? [...memberImages, ...groupImages.filter((i) => !memberImages.includes(i))] : groupImages;
        const link = absoluteUrl(info.url ?? field(member, 'url') ?? pageUrl, pageUrl) ?? pageUrl;
        const attributes: Record<string, string> = perOffer ? queryAttributes(info.url, pageUrl) : {};
        const color = field(member, 'color') ?? attributes['Color'] ?? attributes['color'] ?? null;
        const size = field(member, 'size') ?? attributes['Size'] ?? attributes['size'] ?? null;
        if (color) attributes['Color'] = color;
        if (size) attributes['Size'] = size;
        const title = field(member, 'name') && member !== node ? decodeEntities(field(member, 'name') ?? '') : groupName;
        const sizing = apparelSizing(size, groupName, category);
        out.push({
          id,
          groupId,
          title: truncate(title, 200),
          description: truncate(htmlToText(field(member, 'description') ?? '') || groupDesc || groupName, 9999),
          link,
          imageLink: allImages[0] ?? null,
          additionalImageLinks: allImages.slice(1, 11),
          brand: brandOf(member['brand']) ?? groupBrand ?? pickBrand(groupName, site.config.brandKeywords, site.config.defaultBrand),
          price: { amount: info.price, currency: info.currency ?? fallbackCurrency },
          salePrice: null,
          availability: info.availability,
          attributes,
          size: sizing.size,
          color,
          gender: sizing.gender,
          ageGroup: sizing.ageGroup,
          gtin: gtinOf(member) ?? (offer ? gtinOf(offer) : null),
          mpn: field(member, 'mpn'),
          productType: category,
          lowStockHint: null,
          department: ref.department,
          clearance: ref.clearance,
          featured: ref.featured,
          vehicle: null,
        });
      }
    }
  }
  return out;
}

// ---------- adapter ----------

async function collectSitemapUrls(ctx: AdapterContext, warnings: string[]): Promise<{ urls: string[]; disallow: string[]; pagesFetched: number; truncated: boolean }> {
  const { site, http } = ctx;
  let pagesFetched = 0;
  const robots = await http.getText(new URL('/robots.txt', site.baseUrl).toString());
  pagesFetched++;
  const rules = robots.ok ? parseRobots(robots.text) : { sitemaps: [], disallow: [] };
  const queue = rules.sitemaps.length ? [...rules.sitemaps] : [new URL('/sitemap.xml', site.baseUrl).toString()];
  const visited = new Set<string>();
  const urls = new Set<string>();
  let truncated = false;
  while (queue.length && visited.size < MAX_SITEMAP_FILES && urls.size < site.config.maxSitemapUrls) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    const res = await http.getText(next);
    pagesFetched++;
    if (!res.ok) {
      warnings.push(`sitemap ${next}: ${res.error}`);
      truncated = true;
      continue;
    }
    const map = parseSitemap(res.text);
    // Product sitemaps first when an index splits them out; skip blog/page maps if so.
    const productMaps = map.childSitemaps.filter((s) => /product/i.test(s));
    queue.push(...(productMaps.length ? productMaps : map.childSitemaps));
    for (const u of map.urls) {
      if (urls.size >= site.config.maxSitemapUrls) break;
      urls.add(u);
    }
  }
  if (queue.length > 0 || urls.size >= site.config.maxSitemapUrls) truncated = true;
  return { urls: [...urls], disallow: rules.disallow, pagesFetched, truncated };
}

export const jsonld: Adapter = {
  id: 'jsonld',
  catalogType: 'commerce',

  detect(html) {
    return productNodes(html).length > 0 || /"@type"\s*:\s*"(Product|ProductGroup|Organization|WebSite)"/.test(html);
  },

  async discover(ctx): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const { urls, disallow, pagesFetched, truncated: sitemapTruncated } = await collectSitemapUrls(ctx, warnings);
    const include = compilePatterns(ctx.site.config.includeUrlPatterns);
    const exclude = compilePatterns(ctx.site.config.excludeUrlPatterns);
    const byKey = new Map<string, ProductRef>();
    for (const u of urls) {
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        continue;
      }
      if (isDisallowed(url.pathname, disallow)) continue;
      if (include.length && !include.some((re) => re.test(url.pathname))) continue;
      if (exclude.some((re) => re.test(url.pathname))) continue;
      const key = pageKey(url.toString());
      if (key === '/' || byKey.has(key)) continue;
      byKey.set(key, { key, url: `${url.origin}${url.pathname}`, category: null, department: null, clearance: false, featured: false });
    }
    let refs = [...byKey.values()];
    let truncated = sitemapTruncated;
    if (ctx.site.config.maxProducts !== null && refs.length > ctx.site.config.maxProducts) {
      refs = refs.slice(0, ctx.site.config.maxProducts);
      truncated = true;
    }
    if (refs.length === 0) warnings.push('no candidate URLs found in sitemaps');
    return { refs, pagesFetched, warnings: warnings.slice(0, 200), truncated };
  },

  refFromUrl(raw) {
    try {
      const url = new URL(raw);
      return { key: pageKey(url.toString()), url: `${url.origin}${url.pathname}`, category: null, department: null, clearance: false, featured: false };
    } catch {
      return null;
    }
  },

  async read(ref, ctx): Promise<ReadResult> {
    const res = await ctx.http.getText(ref.url);
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return { kind: 'gone', reason: `HTTP ${res.status}` };
      return { kind: 'error', message: res.error };
    }
    const nodes = productNodes(res.text);
    if (nodes.length === 0) return { kind: 'not_product' };
    const variants = variantsFromJsonLd(nodes, ref, ctx.site, res.url);
    return variants.length ? { kind: 'ok', variants } : { kind: 'error', message: 'Product JSON-LD without a usable offer' };
  },
};
