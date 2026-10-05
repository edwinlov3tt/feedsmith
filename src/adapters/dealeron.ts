// DealerOn (car dealer website platform). Verified against
// northstarfordduluth.com and hendersonchevrolet.com, October 2026.
//
// Discovery: /searchnew.aspx and /searchused.aspx list 12-24 vehicles per page
// (`?pt=N`) as a schema.org ItemList whose entries carry the vehicle page URL
// and the VIN (`identifier`). Paging stops at the first page with no entries,
// or at the 404 DealerOn returns for the page past the last.
// "Call for Price" vehicles have no price anywhere and are kept out of the feed
// (Meta requires one) until the dealer prices them.
// Vehicle pages (VDPs) carry schema.org Vehicle + Product JSON-LD, plus the
// specs schema.org lacks (odometer, trim, stock, colors, CPO) as data-*
// attributes on elements tagged data-vin. "Similar vehicles" cards on the same
// page carry other VINs, so only attributes on this vehicle's VIN are read.
// The dealership (address, coordinates, phone) is the homepage's AutoDealer
// JSON-LD. A sold or removed vehicle's page returns 404.

import { absoluteUrl, decodeEntities, htmlToText, jsonLdBlocks } from '../core/html.ts';
import { asArray, asRecord, field, hasType, type JsonRecord } from '../core/json.ts';
import {
  BODY_STYLES,
  type Dealer,
  type DiscoverResult,
  type ProductRef,
  type ReadResult,
  type Variant,
  type VehicleFields,
} from '../core/model.ts';
import { truncate } from '../core/normalize.ts';
import type { Site } from '../core/site.ts';
import type { Adapter, AdapterContext } from './types.ts';

const MAX_PAGES = 100;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

function jsonLdNodes(html: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6) return;
    for (const item of asArray(node)) {
      const rec = asRecord(item);
      if (!rec) continue;
      out.push(rec);
      if (rec['@graph'] !== undefined) walk(rec['@graph'], depth + 1);
    }
  };
  for (const block of jsonLdBlocks(html)) {
    try {
      walk(JSON.parse(block.replace(/[\u0000-\u001f]+/g, ' ')), 0);
    } catch {
      // Skip malformed blocks; other blocks may still hold the data.
    }
  }
  return out;
}

// ---------- dealer ----------

/** The dealership from the homepage's AutoDealer JSON-LD. Null if incomplete. */
export function parseDealer(html: string): Dealer | null {
  for (const node of jsonLdNodes(html)) {
    if (!hasType(node, 'AutoDealer')) continue;
    const addr = asRecord(node['address']);
    const geo = asRecord(node['geo']);
    const name = field(node, 'name');
    const addr1 = field(addr, 'streetAddress');
    const city = field(addr, 'addressLocality');
    const region = field(addr, 'addressRegion');
    const latitude = Number(field(geo, 'latitude'));
    const longitude = Number(field(geo, 'longitude'));
    if (!name || !addr1 || !city || !region || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    return {
      name: decodeEntities(name).slice(0, 100),
      phone: field(node, 'telephone'),
      addr1,
      city,
      region,
      postalCode: field(addr, 'postalCode'),
      country: field(addr, 'addressCountry') ?? 'US',
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
    };
  }
  return null;
}

// ---------- listing pages ----------

export function parseInventoryPage(html: string, base: string, condition: 'New' | 'Used'): ProductRef[] {
  const refs: ProductRef[] = [];
  for (const node of jsonLdNodes(html)) {
    if (!hasType(node, 'ItemList')) continue;
    for (const item of asArray(node['itemListElement'])) {
      const rec = asRecord(item);
      const url = field(rec, 'url');
      const vin = field(rec, 'identifier')?.toUpperCase() ?? null;
      const abs = url ? absoluteUrl(url, base) : null;
      if (!abs || !vin || !VIN.test(vin)) continue;
      refs.push({ key: vin, url: abs, category: condition, department: null, clearance: false, featured: false });
    }
  }
  return refs;
}

// ---------- vehicle pages ----------

/** data-* attributes from every element tagged with this VIN, merged (first value wins). */
export function vinAttributes(html: string, vin: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`<[a-z][^>]*\\bdata-vin="${vin}"[^>]*>`, 'gi');
  for (const m of html.matchAll(re)) {
    for (const a of m[0].matchAll(/\bdata-([a-z-]+)="([^"]*)"/gi)) {
      const key = (a[1] ?? '').toLowerCase();
      const value = decodeEntities(a[2] ?? '').trim();
      if (value && out[key] === undefined) out[key] = value;
    }
  }
  return out;
}

export function mapBodyStyle(raw: string | null): (typeof BODY_STYLES)[number] {
  const s = (raw ?? '').toLowerCase();
  if (/minivan|passenger van/.test(s)) return 'MINIVAN';
  if (/\bvan\b|cargo/.test(s)) return 'VAN';
  if (/pickup|truck|crew cab|regular cab|extended cab|supercrew|supercab|double cab|quad cab|chassis/.test(s)) return 'TRUCK';
  if (/crossover/.test(s)) return 'CROSSOVER';
  if (/sport utility|\bsuv\b/.test(s)) return 'SUV';
  if (/convertible|cabriolet|roadster/.test(s)) return 'CONVERTIBLE';
  if (/coupe/.test(s)) return 'COUPE';
  if (/hatchback/.test(s)) return 'HATCHBACK';
  if (/wagon/.test(s)) return 'WAGON';
  if (/sedan/.test(s)) return 'SEDAN';
  return 'OTHER';
}

export function mapFuel(raw: string | null): VehicleFields['fuelType'] {
  const s = (raw ?? '').toLowerCase();
  if (!s) return null;
  if (/plug-?in|hybrid/.test(s)) return 'HYBRID';
  if (/electric/.test(s)) return 'ELECTRIC';
  if (/diesel/.test(s)) return 'DIESEL';
  if (/flex/.test(s)) return 'FLEX';
  if (/gas/.test(s)) return 'GASOLINE';
  return 'OTHER';
}

export function mapDrivetrain(raw: string | null): VehicleFields['drivetrain'] {
  const s = (raw ?? '').toUpperCase().replace(/\s/g, '');
  if (!s) return null;
  if (/4X4|4WD/.test(s)) return '4X4';
  if (/AWD|ALLWHEEL/.test(s)) return 'AWD';
  if (/FWD|FRONT/.test(s)) return 'FWD';
  if (/RWD|REAR/.test(s)) return 'RWD';
  if (/4X2|2WD/.test(s)) return '4X2';
  return 'Other';
}

function mapTransmission(raw: string | null): VehicleFields['transmission'] {
  const s = (raw ?? '').toLowerCase();
  if (/auto|cvt/.test(s)) return 'Automatic';
  if (/manual/.test(s)) return 'Manual';
  return null;
}

function price(offers: unknown): number | null {
  for (const o of asArray(offers)) {
    const rec = asRecord(o);
    const spec = asRecord(rec?.['priceSpecification']);
    const n = Number(field(rec, 'price') ?? field(spec, 'price'));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The vehicle's photo gallery, in order, from its inventory photo paths. */
function photos(html: string, vin: string, base: string): string[] {
  const seen = new Map<number, string>();
  for (const m of html.matchAll(new RegExp(`[^"'\\s(]*/inventoryphotos/\\d+/${vin.toLowerCase()}/ip/(\\d+)\\.jpg`, 'gi'))) {
    const n = Number(m[1]);
    const abs = absoluteUrl(m[0], base);
    if (abs && !seen.has(n)) seen.set(n, abs);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);
}

export function parseVehiclePage(html: string, ref: ProductRef, site: Site, pageUrl: string): ReadResult {
  const dealer = site.config.dealer;
  if (!dealer) return { kind: 'error', message: 'dealer location unknown; run a full crawl first' };
  const nodes = jsonLdNodes(html);
  const vin = ref.key.toUpperCase();
  const vehicle = nodes.find((n) => hasType(n, 'Vehicle') && field(n, 'vehicleIdentificationNumber')?.toUpperCase() === vin) ?? nodes.find((n) => hasType(n, 'Vehicle'));
  if (!vehicle) return { kind: 'error', message: 'vehicle page has no Vehicle data' };
  const product = nodes.find((n) => hasType(n, 'Product') && field(n, 'productID')?.toUpperCase() === vin) ?? null;
  const attrs = vinAttributes(html, vin);

  const make = field(asRecord(vehicle['manufacturer']), 'name') ?? field(vehicle, 'brand') ?? attrs['make'] ?? null;
  const model = field(vehicle, 'model') ?? attrs['model'] ?? null;
  const year = Number(field(vehicle, 'vehicleModelDate') ?? attrs['year']);
  const name = field(vehicle, 'name');
  if (!make || !model || !Number.isInteger(year) || !name) return { kind: 'error', message: 'vehicle page missing make, model, year or name' };

  const condition = (field(asRecord(asArray(vehicle['offers'])[0]), 'itemCondition') ?? field(product, 'itemCondition') ?? attrs['type'] ?? '').toLowerCase();
  const isNew = /new/.test(condition) || ref.category === 'New';
  const cpo = /^true$/i.test(attrs['cpo'] ?? '');
  const odometer = Number((attrs['odometer'] ?? '').replace(/[^\d]/g, ''));
  const amount = price(vehicle['offers']) ?? price(product?.['offers']);
  const gallery = photos(html, vin, pageUrl);
  const ldImage = field(vehicle, 'image') ?? field(product, 'image');
  const images = gallery.length ? gallery : ldImage ? [absoluteUrl(ldImage, pageUrl)].filter((u): u is string => u !== null) : [];
  const availability = (field(asRecord(asArray(product?.['offers'] ?? vehicle['offers'])[0]), 'availability') ?? 'InStock').toLowerCase();

  const fields: VehicleFields = {
    vin: VIN.test(vin) ? vin : null,
    make,
    model,
    year,
    trim: attrs['trim']?.slice(0, 50) ?? null,
    mileage: isNew ? 0 : Number.isFinite(odometer) ? odometer : 0,
    mileageUnit: 'MI',
    bodyStyle: mapBodyStyle(field(vehicle, 'bodyType') ?? attrs['bodystyle'] ?? null),
    state: cpo ? 'CPO' : isNew ? 'New' : 'Used',
    drivetrain: mapDrivetrain(attrs['drivetrain'] ?? field(vehicle, 'driveWheelConfiguration')),
    fuelType: mapFuel(field(vehicle, 'fuelType') ?? attrs['fueltype'] ?? null),
    transmission: mapTransmission(attrs['transmission'] ?? field(vehicle, 'vehicleTransmission')),
    interiorColor: attrs['intcolor']?.slice(0, 50) ?? null,
    stockNumber: attrs['stock']?.slice(0, 50) ?? field(product, 'sku'),
    dealer,
  };

  const variant: Variant = {
    id: vin,
    groupId: vin,
    title: truncate(decodeEntities(name), 200),
    description: truncate(htmlToText(field(vehicle, 'description') ?? field(product, 'description') ?? '') || decodeEntities(name), 5000),
    link: field(product, 'url') ?? ref.url,
    imageLink: images[0] ?? null,
    additionalImageLinks: images.slice(1, 20),
    brand: make,
    // A vehicle without a listed price ("call for price") is kept, but left out of the feed.
    price: { amount: (amount ?? 0).toFixed(2), currency: field(asRecord(asArray(vehicle['offers'])[0]), 'priceCurrency') ?? site.config.currency },
    salePrice: null,
    availability: /outofstock|soldout|discontinued/.test(availability) ? 'out of stock' : 'in stock',
    attributes: {},
    size: null,
    color: field(product, 'color') ?? attrs['extcolor'] ?? null,
    gender: null,
    ageGroup: null,
    gtin: null,
    mpn: null,
    productType: fields.state === 'CPO' ? 'Certified Pre-Owned' : fields.state,
    lowStockHint: null,
    department: null,
    clearance: false,
    featured: false,
    vehicle: fields,
  };
  return { kind: 'ok', variants: [variant] };
}

// ---------- adapter ----------

export const dealeron: Adapter = {
  id: 'dealeron',
  catalogType: 'vehicles',

  detect(html) {
    return /dealeron\.com/i.test(html) && /searchnew\.aspx|AutoDealer/i.test(html);
  },

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const { site, http } = ctx;
    const base = site.baseUrl;
    const warnings: string[] = [];
    let pagesFetched = 0;
    let truncated = false;

    const home = await http.getText(base);
    pagesFetched++;
    const dealer = home.ok ? parseDealer(home.text) : null;
    if (!dealer) warnings.push('dealership address not found on the homepage');

    const byVin = new Map<string, ProductRef>();
    for (const [path, condition] of [['searchnew.aspx', 'New'], ['searchused.aspx', 'Used']] as const) {
      for (let pt = 1; pt <= MAX_PAGES; pt++) {
        const res = await http.getText(new URL(`${path}${pt > 1 ? `?pt=${pt}` : ''}`, base).toString());
        pagesFetched++;
        // DealerOn answers 404 for the page after the last one: that's the end, not a failure.
        if (!res.ok && res.status === 404 && pt > 1) break;
        if (!res.ok) {
          warnings.push(`${path} page ${pt}: ${res.error}`);
          truncated = true;
          break;
        }
        const refs = parseInventoryPage(res.text, base, condition);
        const fresh = refs.filter((r) => !byVin.has(r.key));
        for (const r of fresh) byVin.set(r.key, r);
        // An empty page, or one repeating what we have, means past the end.
        if (refs.length === 0 || fresh.length === 0) break;
        if (pt === MAX_PAGES) {
          warnings.push(`${path}: stopped at ${MAX_PAGES} pages`);
          truncated = true;
        }
      }
    }
    let refs = [...byVin.values()];
    if (site.config.maxProducts !== null && refs.length > site.config.maxProducts) {
      refs = refs.slice(0, site.config.maxProducts);
      truncated = true;
    }
    return { refs, pagesFetched, warnings, truncated, dealer: dealer ?? undefined };
  },

  refFromUrl(raw) {
    try {
      const url = new URL(raw);
      const vin = /([A-HJ-NPR-Z0-9]{17})(?:$|[/?#])/i.exec(`${url.pathname}`)?.[1]?.toUpperCase();
      if (!vin) return null;
      const condition = /\/new-/i.test(url.pathname) ? 'New' : 'Used';
      return { key: vin, url: `${url.origin}${url.pathname}`, category: condition, department: null, clearance: false, featured: false };
    } catch {
      return null;
    }
  },

  async read(ref, ctx): Promise<ReadResult> {
    const res = await ctx.http.getText(ref.url);
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return { kind: 'gone', reason: `HTTP ${res.status} (sold or removed)` };
      return { kind: 'error', message: res.error };
    }
    return parseVehiclePage(res.text, ref, ctx.site, res.url);
  },
};
