// PrismRBS (campus store platform, "innerweb v5.0"). Verified against
// universitysupplystore.com and bookstore.illinois.edu, October 2026.
//
// Discovery: category IDs come from the site navigation and department pages;
// each category lists 60 products per page (`&page=N`).
// Products: the detail page renders every in-stock variant inline as
//   btn0_0 = new Button('IVORY COMFORT COLOR',"");
//   agColor = new AttributeGroup("Color",btn0_0);
//   itemList={"items":[{"available":true,"itemNumber":"14342103102","price":"$30.00",...,"buttons":[btn0_0,btn1_0]}]}
// Products with one SKU skip that and put it in <input id="pf_sku" value=...>.
// Sold-out sizes drop out of itemList rather than being flagged, and a
// product with nothing left shows "The product you have requested is not
// available." with HTTP 200.

import { absoluteUrl, attrOf, collapseWhitespace, decodeEntities, htmlToText, innerHtmlById, parsePrice } from '../core/html.ts';
import { mapLimit } from '../core/http.ts';
import type { DiscoverResult, ProductRef, ReadResult, Variant } from '../core/model.ts';
import { apparelSizing, looksLikeSize, pickBrand, sizeAndColor, truncate } from '../core/normalize.ts';
import type { Site } from '../core/site.ts';
import type { Adapter, AdapterContext } from './types.ts';

const PRODUCTS_PER_PAGE = 60;
const GONE_MARKER = /The product you have requested is not available/i;

// ---------- discovery parsing ----------

export interface NavLinks {
  catalogIds: number[];
  departmentPages: string[];
}

/** Category IDs and department (catalog group) pages linked from any page. */
export function parseNavLinks(html: string, base: string): NavLinks {
  const catalogIds = new Set<number>();
  const departments = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
    const href = decodeEntities(m[1] ?? '');
    const abs = absoluteUrl(href, base);
    if (!abs) continue;
    const url = new URL(abs);
    const page = url.pathname.toLowerCase();
    if (page.endsWith('/shop_product_list.asp')) {
      const id = Number(url.searchParams.get('catalog_id'));
      if (Number.isInteger(id) && id > 0) catalogIds.add(id);
    } else if (page.endsWith('/shop_main.asp') && url.searchParams.has('catalog_group_id')) {
      // Both parameters are needed: without catalog_group_name the store
      // answers "Page Not Found" with HTTP 200.
      const id = url.searchParams.get('catalog_group_id') ?? '';
      const name = url.searchParams.get('catalog_group_name') ?? '';
      departments.add(`${url.origin}${url.pathname}?catalog_group_id=${encodeURIComponent(id)}&catalog_group_name=${encodeURIComponent(name)}`);
    }
  }
  return { catalogIds: [...catalogIds].sort((a, b) => a - b), departmentPages: [...departments].sort() };
}

export interface ListPage {
  category: string | null;
  totalItems: number | null;
  pageCount: number;
  products: ProductRef[];
}

export function productUrl(base: string, pfId: string, type: string): string {
  return new URL(`shop_product_detail.asp?pf_id=${encodeURIComponent(pfId)}&type=${encodeURIComponent(type)}`, base).toString();
}

export function parseListPage(html: string, base: string): ListPage {
  const heading = /<h1[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<\/h1>/i.exec(html);
  const category = heading?.[1] ? collapseWhitespace(htmlToText(heading[1])) || null : null;
  const items = /paging-items-info">\s*(\d+)\s*items?/i.exec(html);
  const pages = /paging-page-info">\s*page\s*\d+\s*of\s*(\d+)/i.exec(html);
  const seen = new Set<string>();
  const products: ProductRef[] = [];
  // Only links inside product cards; the nav and "recently viewed" also link products.
  const section = /<section[^>]*class="products-container"[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1] ?? '';
  for (const m of section.matchAll(/href\s*=\s*"([^"]*shop_product_detail\.asp[^"]*)"/gi)) {
    const abs = absoluteUrl(m[1] ?? '', base);
    if (!abs) continue;
    const url = new URL(abs);
    const pfId = url.searchParams.get('pf_id');
    if (!pfId || !/^\d+$/.test(pfId) || seen.has(pfId)) continue;
    seen.add(pfId);
    products.push({ key: pfId, url: productUrl(base, pfId, url.searchParams.get('type') ?? '1'), category, department: null, clearance: false, featured: false });
  }
  return {
    category,
    totalItems: items?.[1] ? Number(items[1]) : null,
    pageCount: pages?.[1] ? Math.max(1, Number(pages[1])) : 1,
    products,
  };
}

export interface DepartmentPage {
  name: string | null;
  catalogIds: number[];
  subGroups: string[];
}

/**
 * A department landing page. Only links inside <main> count: the global nav on
 * every page links every category, which would put everything in every department.
 */
export function parseDepartmentPage(html: string, base: string): DepartmentPage {
  const start = html.search(/<main\b/i);
  const end = html.search(/<\/main>/i);
  const main = start >= 0 ? html.slice(start, end > start ? end : undefined) : '';
  const heading = /<h1[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<\/h1>/i.exec(main);
  const nav = parseNavLinks(main, base);
  return {
    name: heading?.[1] ? collapseWhitespace(htmlToText(heading[1])) || null : null,
    catalogIds: nav.catalogIds,
    subGroups: nav.departmentPages,
  };
}

/** Store categories that are promotions rather than product types. */
export const PROMO_CATEGORY = /clearance|\bsale\b|featured|new arrivals?|gift ideas?|best ?sellers?|deals?\b|specials?\b/i;
const CLEARANCE_CATEGORY = /clearance|\bsale\b/i;
const FEATURED_CATEGORY = /featured/i;

interface CatalogListing {
  id: number;
  name: string | null;
  refs: ProductRef[];
}

/**
 * Merges every category a product is listed in into one ref: the lowest-ID
 * non-promotional category becomes its product_type, and promotional ones
 * become flags.
 */
export function mergeListings(listings: readonly CatalogListing[], departmentOf: ReadonlyMap<number, string>): ProductRef[] {
  const byKey = new Map<string, { ref: ProductRef; catalogs: Array<{ id: number; name: string | null }> }>();
  for (const listing of [...listings].sort((a, b) => a.id - b.id)) {
    for (const ref of listing.refs) {
      const entry = byKey.get(ref.key) ?? { ref, catalogs: [] };
      entry.catalogs.push({ id: listing.id, name: listing.name });
      byKey.set(ref.key, entry);
    }
  }
  const out: ProductRef[] = [];
  for (const { ref, catalogs } of byKey.values()) {
    const specific = catalogs.find((c) => c.name !== null && !PROMO_CATEGORY.test(c.name)) ?? catalogs[0];
    const department = (specific && departmentOf.get(specific.id)) ?? catalogs.map((c) => departmentOf.get(c.id)).find((d) => d !== undefined) ?? null;
    out.push({
      ...ref,
      category: specific?.name ?? null,
      department,
      clearance: catalogs.some((c) => c.name !== null && CLEARANCE_CATEGORY.test(c.name)),
      featured: catalogs.some((c) => c.name !== null && FEATURED_CATEGORY.test(c.name)),
    });
  }
  return out;
}

// ---------- product parsing ----------

interface RawItem {
  available: boolean;
  itemNumber: string;
  price: string;
  attributes: Record<string, string>;
  lowStock: number | null;
}

/** Reads the inline Button/AttributeGroup/itemList script into plain items. */
export function parseVariantScript(html: string): RawItem[] | null {
  const listStart = html.indexOf('itemList=');
  if (listStart < 0) return null;
  const scriptStart = html.lastIndexOf('<script', listStart);
  const scriptEnd = html.indexOf('</script>', listStart);
  const script = html.slice(scriptStart < 0 ? 0 : scriptStart, scriptEnd < 0 ? undefined : scriptEnd);

  const labels = new Map<string, string>();
  for (const m of script.matchAll(/(\w+)\s*=\s*new Button\(\s*'((?:\\.|[^'\\])*)'/g)) {
    if (m[1] && m[2] !== undefined) labels.set(m[1], decodeEntities(m[2].replace(/\\(.)/g, '$1')).trim());
  }
  const groupOf = new Map<string, string>();
  for (const m of script.matchAll(/new AttributeGroup\(\s*"([^"]*)"\s*,([^)]*)\)/g)) {
    const group = m[1] ?? '';
    for (const v of (m[2] ?? '').split(',')) groupOf.set(v.trim(), group);
  }

  const jsonStart = script.indexOf('{', script.indexOf('itemList='));
  const jsonEnd = script.indexOf('psObj', jsonStart);
  if (jsonStart < 0) return null;
  let body = script.slice(jsonStart, jsonEnd < 0 ? undefined : jsonEnd).trim().replace(/;\s*$/, '');
  // Products without options render `"buttons":]` (a PrismRBS template bug that
  // is also a JS syntax error); repair it to an empty list.
  body = body.replace(/"buttons"\s*:\s*\]/g, '"buttons":[]');
  // Button references are bare JS identifiers; quote them so it parses as JSON.
  body = body.replace(/"buttons"\s*:\s*\[([^\]]*)\]/g, (_, refs: string) =>
    `"buttons":${JSON.stringify(refs.split(',').map((r) => r.trim()).filter(Boolean))}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('items' in parsed) || !Array.isArray(parsed.items)) return null;

  const list: unknown[] = parsed.items;
  const items: RawItem[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const itemNumber = 'itemNumber' in raw ? raw.itemNumber : undefined;
    const price = 'price' in raw ? raw.price : undefined;
    if (typeof itemNumber !== 'string' || typeof price !== 'string') continue;
    const attributes: Record<string, string> = {};
    const buttons = 'buttons' in raw && Array.isArray(raw.buttons) ? raw.buttons : [];
    for (const ref of buttons) {
      if (typeof ref !== 'string') continue;
      const label = labels.get(ref);
      const group = groupOf.get(ref);
      if (label !== undefined) attributes[group ?? `Option ${Object.keys(attributes).length + 1}`] = label;
    }
    const availability = 'availability' in raw && typeof raw.availability === 'string' ? raw.availability : '';
    const left = /Only\s+(\d+)\s+left/i.exec(availability);
    items.push({ available: 'available' in raw ? raw.available === true : true, itemNumber, price, attributes, lowStock: left?.[1] ? Number(left[1]) : null });
  }
  return items;
}

function textById(html: string, id: string): string | null {
  const inner = innerHtmlById(html, id);
  if (inner === null) return null;
  const t = collapseWhitespace(htmlToText(inner));
  return t || null;
}

function productName(html: string): string | null {
  const m = /<h1[^>]*class="[^"]*product-name[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m?.[1] ? collapseWhitespace(htmlToText(m[1])) || null : null;
}

function description(html: string): string {
  const inner = innerHtmlById(html, 'product-desc');
  if (!inner) return '';
  // Drop the "Product Description" heading.
  return htmlToText(inner.replace(/<h2[\s\S]*?<\/h2>/i, ''));
}

function images(html: string, base: string): { main: string | null; extra: string[] } {
  const defaultTag = /<input[^>]*id="defaultImage"[^>]*>/i.exec(html)?.[0];
  const main = defaultTag ? absoluteUrl(attrOf(defaultTag, 'value') ?? '', base) : null;
  const extra: string[] = [];
  for (const m of html.matchAll(/<a[^>]*id="additional_product_url-\d+"[^>]*>/gi)) {
    const href = attrOf(m[0], 'href');
    const abs = href ? absoluteUrl(href, base) : null;
    if (abs && abs !== main && !extra.includes(abs)) extra.push(abs);
  }
  return { main, extra: extra.slice(0, 10) };
}

function lowStock(html: string): number | null {
  const m = /low-inventory-message">[^<]*?Only\s+(\d+)\s+left/i.exec(html);
  return m?.[1] ? Number(m[1]) : null;
}

/** ISBN-10 check digits differ from GTIN's, so ISBN-10 is re-encoded as ISBN-13 (978 prefix). */
export function isbnToGtin(raw: string): string | null {
  const isbn = raw.replace(/[-\s]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(isbn)) return isbn;
  if (!/^\d{9}[\dX]$/.test(isbn)) return null;
  const core = `978${isbn.slice(0, 9)}`;
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

function isbnGtin(html: string): string | null {
  const m = /<span class="isbn">\s*([0-9Xx-]{10,17})\s*<\/span>/.exec(html);
  return m?.[1] ? isbnToGtin(m[1]) : null;
}

/** Single-SKU option text is "CRIMSON,SM MEN'S" with no labels; guess which part is the size. */
export function labelSingleOptions(options: string): Record<string, string> {
  const parts = options.split(',').map((p) => p.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (const p of parts) {
    if (out['Size'] === undefined && looksLikeSize(p)) out['Size'] = p;
    else if (out['Color'] === undefined) out['Color'] = p;
    else out[`Option ${Object.keys(out).length + 1}`] = p;
  }
  return out;
}

export function parseProductPage(html: string, ref: ProductRef, site: Site): ReadResult {
  const name = productName(html);
  if (!name) {
    if (GONE_MARKER.test(html)) return { kind: 'gone', reason: 'site reports product not available' };
    return { kind: 'error', message: 'unrecognized product page (no product name)' };
  }
  const base = site.baseUrl;
  const img = images(html, base);
  const desc = description(html);
  const brand = pickBrand(name, site.config.brandKeywords, site.config.defaultBrand);
  const currency = site.config.currency;

  const make = (item: RawItem): Variant | null => {
    const amount = parsePrice(item.price);
    if (!amount) return null;
    const { size: sizeLabel, color } = sizeAndColor(item.attributes);
    const { size, gender, ageGroup } = apparelSizing(sizeLabel, name, ref.category);
    return {
      id: item.itemNumber,
      groupId: ref.key,
      title: truncate(name, 200),
      description: truncate(desc || name, 9999),
      link: ref.url,
      imageLink: img.main,
      additionalImageLinks: img.extra,
      brand,
      price: { amount, currency },
      salePrice: null,
      availability: item.available ? 'in stock' : 'out of stock',
      attributes: item.attributes,
      size,
      color,
      gender,
      ageGroup,
      gtin: null,
      mpn: null,
      productType: ref.category,
      lowStockHint: item.lowStock,
      department: ref.department,
      clearance: ref.clearance,
      featured: ref.featured,
      vehicle: null,
    };
  };

  const scripted = parseVariantScript(html);
  if (scripted) {
    const variants = scripted.map((i) => make(i)).filter((v): v is Variant => v !== null);
    if (variants.length === 0) return { kind: 'error', message: 'variant list present but no usable items' };
    return { kind: 'ok', variants };
  }

  // Merchandise pages give the SKU input id="pf_sku"; book pages (type=3) only name it.
  const skuTag = /<input[^>]*id="pf_sku"[^>]*>/i.exec(html)?.[0] ?? /<input[^>]*name="sku_id"[^>]*>/i.exec(html)?.[0];
  const sku = skuTag ? attrOf(skuTag, 'value') : null;
  if (sku) {
    const price = textById(html, 'price') ?? /<dd class="product-price">([^<]*)<\/dd>/i.exec(html)?.[1] ?? '';
    const addTag = /<input[^>]*id="ajaxAddToCart"[^>]*>/i.exec(html)?.[0];
    const purchasable = addTag !== undefined && !/\sdisabled\b/i.test(addTag);
    // Books echo their title as the "option"; that isn't a size or color.
    const options = textById(html, 'options') ?? '';
    const attributes = options && options !== name ? labelSingleOptions(options) : {};
    const variant = make({ available: purchasable, itemNumber: sku, price, attributes, lowStock: lowStock(html) });
    return variant ? { kind: 'ok', variants: [{ ...variant, gtin: isbnGtin(html) }] } : { kind: 'error', message: 'single SKU without a price' };
  }
  return { kind: 'error', message: 'product page has neither a variant list nor a SKU' };
}

// ---------- adapter ----------

export const prismrbs: Adapter = {
  id: 'prismrbs',
  catalogType: 'commerce',

  detect(html) {
    return /innerweb\/v\d/i.test(html) && /shop_product_list\.asp|shop_main\.asp/i.test(html);
  },

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const { site, http } = ctx;
    const base = site.baseUrl;
    const warnings: string[] = [];
    let pagesFetched = 0;
    const exclude = new Set(site.config.excludeCatalogIds);

    const catalogIds = new Set<number>();
    // Stores can live under a path (e.g. /hawk/), so seeds resolve against the base, not the root.
    const seedPages = [base, new URL('shop_main.asp', base).toString()];
    const topDepartments = new Set<string>();
    for (const page of seedPages) {
      const res = await http.getText(page);
      pagesFetched++;
      if (!res.ok) {
        warnings.push(`seed ${page}: ${res.error}`);
        continue;
      }
      const nav = parseNavLinks(res.text, base);
      nav.catalogIds.forEach((id) => catalogIds.add(id));
      nav.departmentPages.forEach((p) => topDepartments.add(p));
    }

    // Department pages map categories to the store's departments. All pages
    // are read first, then named from the roots down: the nav links some
    // sub-groups (e.g. "Gift Ideas") directly, and those must still take their
    // parent department's name.
    const pages = new Map<string, DepartmentPage>();
    let frontier = [...topDepartments];
    while (frontier.length && pages.size < 200) {
      const batch = frontier.filter((u) => !pages.has(u));
      frontier = [];
      const fetched = await mapLimit(batch, site.config.crawlConcurrency, async (url) => {
        const res = await http.getText(url);
        pagesFetched++;
        if (!res.ok) {
          warnings.push(`department ${url}: ${res.error}`);
          return null;
        }
        const dept = parseDepartmentPage(res.text, base);
        if (dept.catalogIds.length === 0 && dept.subGroups.length === 0) warnings.push(`department ${url}: no categories found (page layout changed?)`);
        return { url, dept };
      });
      for (const f of fetched) {
        if (!f) continue;
        pages.set(f.url, f.dept);
        frontier.push(...f.dept.subGroups.filter((u) => !pages.has(u)));
      }
    }
    const departmentOf = new Map<number, string>();
    const children = new Set([...pages.values()].flatMap((d) => d.subGroups));
    const assign = (url: string, name: string | null, seen: Set<string>): void => {
      const dept = pages.get(url);
      if (!dept || seen.has(url)) return;
      seen.add(url);
      const label = name ?? dept.name;
      for (const id of dept.catalogIds) {
        catalogIds.add(id);
        if (label && !departmentOf.has(id)) departmentOf.set(id, label);
      }
      for (const sub of dept.subGroups) assign(sub, label, seen);
    };
    for (const url of pages.keys()) if (!children.has(url)) assign(url, null, new Set());
    // Anything only reachable in a cycle still contributes its categories.
    for (const dept of pages.values()) for (const id of dept.catalogIds) catalogIds.add(id);

    const listUrl = (id: number, page: number): string =>
      new URL(`shop_product_list.asp?catalog_id=${id}&sort=0${page > 1 ? `&page=${page}` : ''}`, base).toString();

    let incomplete = false;
    const catalogs = [...catalogIds].filter((id) => !exclude.has(id)).sort((a, b) => a - b);
    const listings = await mapLimit(catalogs, site.config.crawlConcurrency, async (id): Promise<CatalogListing> => {
      const first = await http.getText(listUrl(id, 1));
      pagesFetched++;
      if (!first.ok) {
        warnings.push(`catalog ${id}: ${first.error}`);
        incomplete = true;
        return { id, name: null, refs: [] };
      }
      const page1 = parseListPage(first.text, base);
      const pages = [page1];
      for (let p = 2; p <= page1.pageCount; p++) {
        const res = await http.getText(listUrl(id, p));
        pagesFetched++;
        if (res.ok) pages.push(parseListPage(res.text, base));
        else {
          warnings.push(`catalog ${id} page ${p}: ${res.error}`);
          incomplete = true;
        }
      }
      const refs = pages.flatMap((pg) => pg.products);
      if (page1.totalItems !== null && refs.length < Math.min(page1.totalItems, page1.pageCount * PRODUCTS_PER_PAGE)) {
        warnings.push(`catalog ${id}: site reports ${page1.totalItems} items, parsed ${refs.length}`);
      }
      return { id, name: page1.category, refs };
    });

    let refs = mergeListings(listings, departmentOf).sort((a, b) => Number(a.key) - Number(b.key));
    let truncated = incomplete;
    if (site.config.maxProducts !== null && refs.length > site.config.maxProducts) {
      refs = refs.slice(0, site.config.maxProducts);
      truncated = true;
    }
    return { refs, pagesFetched, warnings: warnings.slice(0, 200), truncated };
  },

  refFromUrl(raw, site) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const pfId = url.searchParams.get('pf_id');
    if (!/shop_product_detail\.asp$/i.test(url.pathname) || !pfId || !/^\d+$/.test(pfId)) return null;
    return { key: pfId, url: productUrl(site.baseUrl, pfId, url.searchParams.get('type') ?? '1'), category: null, department: null, clearance: false, featured: false };
  },

  async read(ref, ctx) {
    const res = await ctx.http.getText(ref.url);
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return { kind: 'gone', reason: `HTTP ${res.status}` };
      return { kind: 'error', message: res.error };
    }
    return parseProductPage(res.text, ref, ctx.site);
  },
};
