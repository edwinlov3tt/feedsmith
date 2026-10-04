import { describe, expect, it } from 'vitest';
import type { MetaRow } from '../src/core/feed.ts';
import { matchesSet, parseSetFilter, toMetaFilter } from '../src/core/set-filter.ts';

const row = (over: Partial<MetaRow> = {}): MetaRow => ({
  id: '100',
  title: 'Tee',
  description: 'd',
  availability: 'in stock',
  condition: 'new',
  link: 'https://x',
  image_link: 'https://x/i.png',
  brand: 'Store',
  price: '30.00 USD',
  sale_price: '',
  item_group_id: 'g',
  gender: 'female',
  color: 'CRIMSON',
  size: 'M',
  age_group: 'adult',
  gtin: '',
  mpn: '',
  product_type: 'T-Shirts',
  additional_image_link: '',
  custom_label_0: 'Bama Merchandise',
  custom_label_1: '',
  custom_label_2: '$25-$50',
  custom_label_3: '',
  ...over,
});

function parse(raw: unknown) {
  const r = parseSetFilter(raw);
  if (!r.ok) throw new Error(r.error);
  return r.filter;
}

describe('product set filters', () => {
  it('round-trips Meta filter JSON', () => {
    const json = { and: [{ availability: { eq: 'in stock' } }, { custom_label_1: { neq: 'clearance' } }, { or: [{ gender: { eq: 'female' } }, { age_group: { is_any: ['kids'] } }] }] };
    expect(toMetaFilter(parse(json))).toEqual(json);
  });

  it('matches like Meta: case-insensitive, empty label is not "clearance"', () => {
    const inStockNotClearance = parse({ and: [{ availability: { eq: 'In Stock' } }, { custom_label_1: { neq: 'clearance' } }] });
    expect(matchesSet(inStockNotClearance, row())).toBe(true);
    expect(matchesSet(inStockNotClearance, row({ custom_label_1: 'clearance' }))).toBe(false);
    expect(matchesSet(parse({ product_type: { i_contains: 'shirt' } }), row())).toBe(true);
    expect(matchesSet(parse({ age_group: { is_any: ['kids', 'toddler'] } }), row())).toBe(false);
    expect(matchesSet(parse({ retailer_id: { is_any: ['100', '200'] } }), row())).toBe(true);
    expect(matchesSet(parse({}), row())).toBe(true);
  });

  it('compares price_amount in cents', () => {
    expect(matchesSet(parse({ price_amount: { lt: 2500 } }), row())).toBe(false);
    expect(matchesSet(parse({ price_amount: { gte: 3000 } }), row())).toBe(true);
  });

  it.each([
    [{ title: { eq: 'x' } }, /unsupported field "title"/],
    [{ gender: { like: 'x' } }, /unsupported operator/],
    [{ gender: { eq: 'x' }, brand: { eq: 'y' } }, /one key per object/],
    [{ and: [] }, /non-empty array/],
    [{ is_any: 1 }, /unsupported field/],
    [{ price_amount: { lt: '25' } }, /whole cents/],
    [{ age_group: { is_any: [] } }, /non-empty array/],
    ['not an object', /expected an object/],
  ])('rejects %j', (raw, message) => {
    const r = parseSetFilter(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('limits nesting depth', () => {
    let deep: unknown = { gender: { eq: 'female' } };
    for (let i = 0; i < 6; i++) deep = { and: [deep] };
    expect(parseSetFilter(deep).ok).toBe(false);
  });
});
