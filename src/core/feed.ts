// Meta catalog feed format. The same row feeds the CSV file, change detection
// and the Batch API, so what Meta sees is exactly what is compared.

import type { Availability, Money, Variant } from './model.ts';

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

/** Columns whose value differs between two variants, in feed terms. */
export function changedColumns(before: Variant, after: Variant): MetaColumn[] {
  const a = toMetaRow(before);
  const b = toMetaRow(after);
  return META_COLUMNS.filter((c) => a[c] !== b[c]);
}

/** Meta rejects items without these; such variants are left out of the feed. */
export function feedProblem(v: Variant): string | null {
  if (!v.imageLink) return 'missing image';
  if (!v.brand && !v.gtin && !v.mpn) return 'missing brand';
  return null;
}

function csvCell(value: string): string {
  // Meta reads this file, not a spreadsheet, so text is kept as-is except a
  // leading = or @, which would execute if someone opened it in Excel.
  const safe = /^[=@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvHeader(): string {
  return `${META_COLUMNS.join(',')}\r\n`;
}

export function csvLine(row: MetaRow): string {
  return `${META_COLUMNS.map((c) => csvCell(row[c])).join(',')}\r\n`;
}
