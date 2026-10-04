import { describe, expect, it } from 'vitest';
import { diffProduct } from '../src/core/diff.ts';
import { csvHeader, csvLine, feedProblem, priceBand, toMetaRow } from '../src/core/feed.ts';
import { VariantSchema, type Variant } from '../src/core/model.ts';

function variant(id: string, over: Partial<Variant> = {}): Variant {
  return VariantSchema.parse({
    id,
    groupId: 'g1',
    title: 'Tide Tee',
    description: 'A shirt',
    link: 'https://store.example/p?pf_id=1',
    imageLink: 'https://store.example/i.png',
    additionalImageLinks: [],
    brand: 'Store',
    price: { amount: '30.00', currency: 'USD' },
    salePrice: null,
    availability: 'in stock',
    attributes: { Size: 'SM' },
    size: 'SM',
    color: null,
    gender: null,
    ageGroup: null,
    gtin: null,
    mpn: null,
    productType: null,
    lowStockHint: null,
    ...over,
  });
}

describe('diffProduct', () => {
  it('records new variants as created', () => {
    const d = diffProduct([], [variant('a')]);
    expect(d.changes).toEqual([{ variantId: 'a', kind: 'created', fields: [] }]);
    expect(d.upserts).toHaveLength(1);
  });

  it('records nothing when nothing in the feed changed', () => {
    expect(diffProduct([variant('a')], [variant('a')])).toEqual({ upserts: [], changes: [] });
  });

  it('keeps low-stock hints current without logging a feed change', () => {
    const d = diffProduct([variant('a')], [variant('a', { lowStockHint: 2 })]);
    expect(d.changes).toEqual([]);
    expect(d.upserts[0]?.lowStockHint).toBe(2);
  });

  it('classifies price changes as updates with the changed columns', () => {
    const d = diffProduct([variant('a')], [variant('a', { price: { amount: '25.00', currency: 'USD' } })]);
    expect(d.changes).toEqual([{ variantId: 'a', kind: 'updated', fields: ['price'] }]);
  });

  it('marks a size that disappeared from the page as out of stock, not deleted', () => {
    const d = diffProduct([variant('a'), variant('b')], [variant('a')]);
    expect(d.changes).toEqual([{ variantId: 'b', kind: 'out_of_stock', fields: ['availability'] }]);
    expect(d.upserts[0]).toMatchObject({ id: 'b', availability: 'out of stock' });
  });

  it('marks every variant out of stock when the product is gone, once', () => {
    const d = diffProduct([variant('a'), variant('b')], 'gone');
    expect(d.changes.map((c) => c.kind)).toEqual(['out_of_stock', 'out_of_stock']);
    const again = diffProduct(d.upserts, 'gone');
    expect(again.changes).toEqual([]);
  });

  it('detects a sold-out size coming back', () => {
    const d = diffProduct([variant('a', { availability: 'out of stock' })], [variant('a')]);
    expect(d.changes).toEqual([{ variantId: 'a', kind: 'back_in_stock', fields: ['availability'] }]);
  });
});

describe('meta feed rows', () => {
  it('formats money and joins images', () => {
    const row = toMetaRow(variant('a', { additionalImageLinks: ['https://x/1.png', 'https://x/2.png'] }));
    expect(row.price).toBe('30.00 USD');
    expect(row.sale_price).toBe('');
    expect(row.condition).toBe('new');
    expect(row.additional_image_link).toBe('https://x/1.png,https://x/2.png');
    expect(row.item_group_id).toBe('g1');
  });

  it('escapes CSV cells and neutralizes spreadsheet formulas', () => {
    const line = csvLine(toMetaRow(variant('a', { title: 'Tee, "Classic"', description: '=HYPERLINK("x")' })));
    expect(line).toContain('"Tee, ""Classic"""');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line.endsWith('\r\n')).toBe(true);
    // Same order as Meta's catalog template: required columns first.
    expect(csvHeader().startsWith('id,title,description,availability,condition,link,image_link,brand,price')).toBe(true);
  });

  it('writes product-set labels', () => {
    const row = toMetaRow(variant('a', { department: 'Bama Merchandise', clearance: true, featured: false, price: { amount: '59.99', currency: 'USD' } }));
    expect([row.custom_label_0, row.custom_label_1, row.custom_label_2, row.custom_label_3]).toEqual(['Bama Merchandise', 'clearance', '$50-$100', '']);
    expect([priceBand('24.99'), priceBand('25.00'), priceBand('99.99'), priceBand('100.00')]).toEqual(['Under $25', '$25-$50', '$50-$100', '$100+']);
  });

  it('flags items Meta would reject', () => {
    expect(feedProblem(variant('a', { imageLink: null }))).toBe('missing image');
    expect(feedProblem(variant('a', { brand: null }))).toBe('missing brand');
    expect(feedProblem(variant('a'))).toBeNull();
  });
});
