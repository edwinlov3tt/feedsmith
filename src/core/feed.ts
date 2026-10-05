// Meta catalog feed format. The same row feeds the CSV file, change detection
// and the Batch API, so what Meta sees is exactly what is compared.

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
  'additional_image_link',
  // Product set filters (see docs/product-sets.md).
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
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

export function toMetaRow(v: Variant): MetaRow {
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
    additional_image_link: v.additionalImageLinks.join(','),
    custom_label_0: v.department ?? '',
    custom_label_1: v.clearance ? 'clearance' : '',
    custom_label_2: priceBand(v.salePrice?.amount ?? v.price.amount),
    custom_label_3: v.featured ? 'featured' : '',
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

/** Meta rejects items without these; such variants are left out of the feed. */
export function feedProblem(v: Variant): string | null {
  if (!v.imageLink) return 'missing image';
  if (v.vehicle) {
    if (Number(v.price.amount) <= 0) return 'missing price';
    return null;
  }
  if (!v.brand && !v.gtin && !v.mpn) return 'missing brand';
  return null;
}

function csvCell(value: string): string {
  // Meta reads this file, not a spreadsheet, so text is kept as-is except a
  // leading = or @, which would execute if someone opened it in Excel.
  const safe = /^[=@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvHeader(type: CatalogType = 'commerce'): string {
  return `${feedColumns(type).join(',')}\r\n`;
}

export function csvLine(row: FeedRow, type: CatalogType = 'commerce'): string {
  return `${feedColumns(type).map((c) => csvCell(row[c] ?? '')).join(',')}\r\n`;
}
