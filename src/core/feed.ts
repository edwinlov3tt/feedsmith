// Catalog feed formats. The Meta row feeds the CSV file, change detection and
// the Batch API, so what Meta sees is exactly what is compared. Other
// platforms' files (TikTok) are views of the same variants.

import { clothingType } from './classify.ts';
import type { Availability, CatalogType, Money, Variant } from './model.ts';

// Order follows Meta's own catalog template (Commerce Manager > Add items >
// Data feed > template, October 2026): its required columns first, then the
// optional ones we fill, then fields Meta accepts that its template omits.
export const META_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'link',
  'image_link',
  'brand',
  'price',
  'sale_price',
  'item_group_id',
  'gender',
  'color',
  'size',
  'age_group',
  'gtin',
  'mpn',
  'product_type',
  'google_product_category',
  'additional_image_link',
  // Product set filters (see docs/product-sets.md).
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
] as const;
export type MetaColumn = (typeof META_COLUMNS)[number];
export type MetaRow = Record<MetaColumn, string>;

// Meta automotive inventory feed (Auto Ads reference, Vehicle + Dealership
// fields, October 2026): required columns first, in the reference's order.
const VEHICLE_IMAGE_COLUMNS = Array.from({ length: 10 }, (_, i) => `image[${i}].url`);
export const VEHICLE_COLUMNS = [
  'vehicle_id',
  'title',
  'description',
  'url',
  'make',
  'model',
  'year',
  'mileage.value',
  'mileage.unit',
  ...VEHICLE_IMAGE_COLUMNS,
  'body_style',
  'price',
  'exterior_color',
  'state_of_vehicle',
  'address.addr1',
  'address.city',
  'address.region',
  'address.postal_code',
  'address.country',
  'latitude',
  'longitude',
  'availability',
  'vin',
  'trim',
  'transmission',
  'drivetrain',
  'fuel_type',
  'interior_color',
  'stock_number',
  'dealer_name',
  'dealer_phone',
  'sale_price',
  // Product set filter: vehicle price band.
  'custom_label_0',
];

/** Any feed row, product or vehicle: column name to cell text. */
export type FeedRow = Record<string, string>;

function money(m: Money | null): string {
  return m ? `${m.amount} ${m.currency}` : '';
}

/**
 * Meta's catalog availability values. Its feed template lists only "in stock"
 * and "out of stock"; the Batch API adds "available for order" and
 * "discontinued". A pre-order is sent as "available for order".
 */
export function metaAvailability(a: Availability): string {
  return a === 'preorder' ? 'available for order' : a;
}

/** Price bands for product sets; boundaries are inclusive at the bottom. */
export function priceBand(amount: string): string {
  const n = Number(amount);
  if (n < 25) return 'Under $25';
  if (n < 50) return '$25-$50';
  if (n < 100) return '$50-$100';
  return '$100+';
}

/**
 * Store promotions an item is listed in, space-separated ("featured", "new",
 * "featured new"); sets filter on it with "contains".
 */
export function merchTags(v: Pick<Variant, 'featured' | 'newItem'>): string {
  return [v.featured ? 'featured' : '', v.newItem ? 'new' : ''].filter(Boolean).join(' ');
}

export function toMetaRow(v: Variant): MetaRow {
  const clothing = clothingType(v.title, v.productType);
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    availability: metaAvailability(v.availability),
    condition: 'new',
    link: v.link,
    image_link: v.imageLink ?? '',
    brand: v.brand ?? '',
    price: money(v.price),
    sale_price: money(v.salePrice),
    item_group_id: v.groupId,
    gender: v.gender ?? '',
    color: v.color ?? '',
    size: v.size ?? '',
    age_group: v.ageGroup ?? '',
    gtin: v.gtin ?? '',
    mpn: v.mpn ?? '',
    product_type: v.productType ?? '',
    google_product_category: clothing?.google ?? '',
    additional_image_link: v.additionalImageLinks.join(','),
    custom_label_0: v.department ?? '',
    custom_label_1: v.clearance ? 'clearance' : '',
    custom_label_2: priceBand(v.salePrice?.amount ?? v.price.amount),
    custom_label_3: merchTags(v),
    custom_label_4: clothing?.label ?? '',
  };
}

// TikTok catalog template (Catalog Manager > Add products > Data feed >
// template, October 2026), in its order, keeping only columns we fill.
export const TIKTOK_COLUMNS = [
  'sku_id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
  'additional_image_link',
  'age_group',
  'color',
  'gender',
  'item_group_id',
  'google_product_category',
  'product_type',
  'sale_price',
  'gtin',
  'mpn',
  'size',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
] as const;

// TikTok's age_group takes newborn, infant, toddler, kids and adult only.
const TIKTOK_AGE_GROUPS = new Set(['newborn', 'infant', 'toddler', 'kids', 'adult']);

/** TikTok takes only image links that end in .jpg or .png. */
export function isJpgOrPng(url: string): boolean {
  return /\.(jpe?g|png)$/i.test(new URL(url).pathname);
}

/**
 * Copies of a site's images on our own host: source URL to public URL, or null
 * for an image known to be unusable (broken, too small). An image not listed
 * hasn't been copied yet and keeps its store URL.
 */
export type ImageMirror = ReadonlyMap<string, string | null>;

const NO_MIRROR: ImageMirror = new Map();

/** The variant's image links in a format TikTok takes, as the store lists them. */
export function jpgOrPngImages(v: Variant): string[] {
  return [v.imageLink, ...v.additionalImageLinks].filter((u): u is string => u !== null && isJpgOrPng(u));
}

/** The variant's images TikTok can use: the first usable one is the main one, then up to 10 more. */
export function tiktokImages(v: Variant, mirror: ImageMirror = NO_MIRROR): { main: string | null; extra: string[] } {
  const usable = jpgOrPngImages(v).flatMap((source) => {
    const copy = mirror.get(source);
    if (copy === undefined) return [source];
    return copy === null ? [] : [copy];
  });
  return { main: usable[0] ?? null, extra: usable.slice(1, 11) };
}

/** Why an item is left out of the TikTok file, or null to include it. */
export function tiktokProblem(v: Variant, mirror: ImageMirror = NO_MIRROR): string | null {
  const problem = feedProblem(v);
  if (problem) return problem;
  if (v.vehicle) return 'vehicle';
  // Meta accepts a GTIN or MPN instead of a brand; TikTok requires the brand.
  if (!v.brand) return 'missing brand';
  if (!tiktokImages(v).main) return 'image not JPG or PNG';
  if (!tiktokImages(v, mirror).main) return 'image broken or under 500x500';
  return null;
}

/**
 * Description text for TikTok, which refuses control characters and emoji. Line
 * breaks become spaces. Invisible characters such as soft hyphens are removed,
 * along with pictographic symbols; that covers ™ and ®, which Unicode counts as
 * emoji. Store pages also leave stray "<br" in the text, usually with no ">" and
 * often stuck to the next word ("<brMSI"). "<brand" isn't one, so a lowercase
 * letter after it rules it out.
 */
export function tiktokDescription(text: string): string {
  return text
    .replace(/<[bB][rR](?![a-z])\s*\/?>?/g, ' ')
    .replace(/[\p{Cf}\p{Extended_Pictographic}️]/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** A product in TikTok's catalog columns. Same values as the Meta row, renamed where TikTok differs. */
export function toTikTokRow(v: Variant, mirror: ImageMirror = NO_MIRROR): FeedRow {
  const meta = toMetaRow(v);
  const images = tiktokImages(v, mirror);
  return {
    ...meta,
    sku_id: meta.id,
    // TikTok requires a description, so one that is nothing but symbols falls back to the title.
    description: tiktokDescription(v.description) || v.title,
    availability: v.availability,
    image_link: images.main ?? '',
    additional_image_link: images.extra.join(','),
    age_group: TIKTOK_AGE_GROUPS.has(meta.age_group) ? meta.age_group : '',
  };
}

/** Vehicle price bands for product sets. */
export function vehiclePriceBand(amount: string): string {
  const n = Number(amount);
  if (n < 20_000) return 'Under $20k';
  if (n < 35_000) return '$20k-$35k';
  if (n < 50_000) return '$35k-$50k';
  return '$50k+';
}

/** A vehicle in Meta's automotive feed columns. Throws if called on a product. */
export function toVehicleRow(v: Variant): FeedRow {
  const car = v.vehicle;
  if (!car) throw new Error(`variant ${v.id} has no vehicle fields`);
  const images = [v.imageLink, ...v.additionalImageLinks].filter((u): u is string => u !== null);
  const row: FeedRow = {
    vehicle_id: v.id,
    title: v.title,
    description: v.description,
    url: v.link,
    make: car.make,
    model: car.model,
    year: String(car.year),
    'mileage.value': String(car.mileage),
    'mileage.unit': car.mileageUnit,
    body_style: car.bodyStyle,
    price: money(v.price),
    exterior_color: v.color ?? '',
    state_of_vehicle: car.state,
    'address.addr1': car.dealer.addr1,
    'address.city': car.dealer.city,
    'address.region': car.dealer.region,
    'address.postal_code': car.dealer.postalCode ?? '',
    'address.country': car.dealer.country,
    latitude: String(car.dealer.latitude),
    longitude: String(car.dealer.longitude),
    // Meta vehicles use available / not_available.
    availability: v.availability === 'in stock' || v.availability === 'preorder' || v.availability === 'available for order' ? 'available' : 'not_available',
    vin: car.vin ?? '',
    trim: car.trim ?? '',
    transmission: car.transmission ?? '',
    drivetrain: car.drivetrain ?? '',
    fuel_type: car.fuelType ?? '',
    interior_color: car.interiorColor ?? '',
    stock_number: car.stockNumber ?? '',
    dealer_name: car.dealer.name,
    dealer_phone: car.dealer.phone ?? '',
    sale_price: money(v.salePrice),
    custom_label_0: vehiclePriceBand(v.salePrice?.amount ?? v.price.amount),
  };
  VEHICLE_IMAGE_COLUMNS.forEach((col, i) => {
    row[col] = images[i] ?? '';
  });
  return row;
}

export function catalogTypeOfItem(v: Variant): CatalogType {
  return v.vehicle ? 'vehicles' : 'commerce';
}

export function feedColumns(type: CatalogType): readonly string[] {
  return type === 'vehicles' ? VEHICLE_COLUMNS : META_COLUMNS;
}

/** The item as a row of its catalog's feed. */
export function toFeedRow(v: Variant): FeedRow {
  return v.vehicle ? toVehicleRow(v) : toMetaRow(v);
}

/** Columns whose value differs between two variants, in feed terms. */
export function changedColumns(before: Variant, after: Variant): string[] {
  const a = toFeedRow(before);
  const b = toFeedRow(after);
  const cols = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...cols].filter((c) => a[c] !== b[c]);
}

/** PrismRBS's stand-in for a product without a photo; an ad showing it is worse than no item. */
export const PLACEHOLDER_IMAGE = /\/not_available[^/]*$/i;

/** Meta rejects items without these; such variants are left out of the feed. */
export function feedProblem(v: Variant): string | null {
  // Rows stored before the adapter dropped placeholders can still carry one.
  if (!v.imageLink || PLACEHOLDER_IMAGE.test(v.imageLink)) return 'missing image';
  // $0 is a store data error, or "Call for Price" on a dealer site; an ad must not say free.
  if (Number(v.price.amount) <= 0) return 'missing price';
  if (v.vehicle) return null;
  if (!v.brand && !v.gtin && !v.mpn) return 'missing brand';
  return null;
}

function csvCell(value: string): string {
  // Meta reads this file, not a spreadsheet, so text is kept as-is except a
  // leading = or @, which would execute if someone opened it in Excel.
  const safe = /^[=@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvHeader(type: CatalogType = 'commerce', columns: readonly string[] = feedColumns(type)): string {
  return `${columns.join(',')}\r\n`;
}

export function csvLine(row: FeedRow, type: CatalogType = 'commerce', columns: readonly string[] = feedColumns(type)): string {
  return `${columns.map((c) => csvCell(row[c] ?? '')).join(',')}\r\n`;
}
