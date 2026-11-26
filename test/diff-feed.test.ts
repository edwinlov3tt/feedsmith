import { describe, expect, it } from 'vitest';
import { diffProduct } from '../src/core/diff.ts';
import { csvHeader, csvLine, feedProblem, priceBand, TIKTOK_COLUMNS, tiktokDescription, tiktokProblem, toMetaRow, toTikTokRow } from '../src/core/feed.ts';
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
    const row = toMetaRow(variant('a', { department: 'Bama Merchandise', clearance: true, featured: false, newItem: false, price: { amount: '59.99', currency: 'USD' } }));
    expect([row.custom_label_0, row.custom_label_1, row.custom_label_2, row.custom_label_3]).toEqual(['Bama Merchandise', 'clearance', '$50-$100', '']);
    expect([priceBand('24.99'), priceBand('25.00'), priceBand('99.99'), priceBand('100.00')]).toEqual(['Under $25', '$25-$50', '$50-$100', '$100+']);
    // Promotions share custom_label_3, filtered with "contains".
    expect(toMetaRow(variant('a', { newItem: true })).custom_label_3).toBe('new');
    expect(toTikTokRow(variant('a', { featured: true, newItem: true })).custom_label_3).toBe('featured new');
  });

  it('flags items Meta would reject', () => {
    expect(feedProblem(variant('a', { imageLink: null }))).toBe('missing image');
    expect(feedProblem(variant('a', { brand: null }))).toBe('missing brand');
    expect(feedProblem(variant('a', { price: { amount: '0.00', currency: 'USD' } }))).toBe('missing price');
    expect(feedProblem(variant('a', { imageLink: 'https://store.example/outerweb/product_images/not_available_large.webp' }))).toBe('missing image');
    expect(feedProblem(variant('a'))).toBeNull();
  });

  it('writes a Google category and clothing type', () => {
    const row = toMetaRow(variant('a', { title: 'Alabama Script A Chill Out Snapback', productType: 'Caps, Hats, & Beanies' }));
    expect([row.google_product_category, row.custom_label_4]).toEqual(['Apparel & Accessories > Clothing Accessories > Hats', 'Hats']);
    const mug = toMetaRow(variant('a', { title: 'Alabama Campus Grande Mug' }));
    expect([mug.google_product_category, mug.custom_label_4]).toEqual(['', '']);
  });
});

describe('tiktok feed rows', () => {
  it('uses sku_id and TikTok values', () => {
    const row = toTikTokRow(variant('a', { ageGroup: 'teen', availability: 'preorder' }));
    expect(row['sku_id']).toBe('a');
    // TikTok takes "preorder" as is; Meta's file says "available for order".
    expect(row['availability']).toBe('preorder');
    // No "teen" in TikTok's age groups.
    expect(row['age_group']).toBe('');
    expect(csvHeader('commerce', TIKTOK_COLUMNS).startsWith('sku_id,title,description,availability,condition,price,link,image_link,brand')).toBe(true);
    expect(csvLine(row, 'commerce', TIKTOK_COLUMNS).split(',')[0]).toBe('a');
  });

  it('cleans TikTok descriptions of what its rules refuse', () => {
    // Forms seen in the live feeds.
    expect(tiktokDescription('140W ADAPTER<br\nThe 140W adapter')).toBe('140W ADAPTER The 140W adapter');
    expect(tiktokDescription('Item # 1<brSpirit Products LTD\nMade in USA')).toBe('Item # 1 Spirit Products LTD Made in USA');
    expect(tiktokDescription('One<br>Two<br />Three<BR>Four')).toBe('One Two Three Four');
    expect(tiktokDescription('Nike® Dri-FIT™ tee © 2026 🎉')).toBe('Nike Dri-FIT tee 2026');
    expect(tiktokDescription('Line one\r\n\r\nLine two\tend more')).toBe('Line one Line two end more');
    expect(tiktokDescription('soft­hyphen')).toBe('softhyphen');
    expect(tiktokDescription('flag ❤️ here')).toBe('flag here');
  });

  it('leaves ordinary description text alone', () => {
    const text = 'Size 3 #5 * 100% cotton, 40° wash & "dry" <brand> <Roll Tide! Café';
    expect(tiktokDescription(text)).toBe(text);
  });

  it('cleans only the TikTok file, and never leaves its description empty', () => {
    const v = variant('a', { description: 'Soft®\nshirt' });
    expect(toTikTokRow(v)['description']).toBe('Soft shirt');
    expect(toMetaRow(v).description).toBe('Soft®\nshirt');
    expect(toTikTokRow(variant('a', { description: '®™', title: 'Shirt' }))['description']).toBe('Shirt');
  });

  it('uses our copies of images, keeps store links for ones not copied yet, and skips bad ones', () => {
    const v = variant('a', { imageLink: 'https://x/small.jpg', additionalImageLinks: ['https://x/good.jpg', 'https://x/waiting.png'] });
    const mirror = new Map([
      ['https://x/small.jpg', null],
      ['https://x/good.jpg', 'https://us/images/a/1.jpg'],
    ]);
    const row = toTikTokRow(v, mirror);
    expect(row['image_link']).toBe('https://us/images/a/1.jpg');
    expect(row['additional_image_link']).toBe('https://x/waiting.png');
    expect(tiktokProblem(v, mirror)).toBeNull();
    expect(toMetaRow(v).image_link).toBe('https://x/small.jpg');
  });

  it('leaves an item out when every image is known to be unusable', () => {
    const v = variant('a', { imageLink: 'https://x/small.jpg', additionalImageLinks: [] });
    expect(tiktokProblem(v, new Map([['https://x/small.jpg', null]]))).toBe('image broken or under 500x500');
    expect(tiktokProblem(v)).toBeNull();
  });

  it('uses only JPG and PNG images, promoting the first usable one', () => {
    const v = variant('a', { imageLink: 'https://x/main.webp', additionalImageLinks: ['https://x/cover_image.asp?Key=1', 'https://x/2.JPG', 'https://x/3.png?v=2'] });
    const row = toTikTokRow(v);
    expect(row['image_link']).toBe('https://x/2.JPG');
    expect(row['additional_image_link']).toBe('https://x/3.png?v=2');
    expect(tiktokProblem(v)).toBeNull();
  });

  it('leaves out items with no usable image, and vehicles', () => {
    expect(tiktokProblem(variant('a', { imageLink: 'https://x/cover_image.asp?Key=1&Size=M' }))).toBe('image not JPG or PNG');
    expect(tiktokProblem(variant('a', { imageLink: null }))).toBe('missing image');
    // Meta takes a GTIN in place of a brand; TikTok doesn't.
    expect(feedProblem(variant('a', { brand: null, gtin: '9781234567897' }))).toBeNull();
    expect(tiktokProblem(variant('a', { brand: null, gtin: '9781234567897' }))).toBe('missing brand');
    expect(tiktokProblem(variant('a'))).toBeNull();
  });
});
