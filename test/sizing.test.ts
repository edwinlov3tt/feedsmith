import { describe, expect, it } from 'vitest';
import { apparelSizing } from '../src/core/normalize.ts';

describe('apparelSizing', () => {
  it.each([
    ['SM UNISEX', 'Tide Together T-Shirt', 'T-Shirts', { size: 'S', gender: 'unisex', ageGroup: 'adult' }],
    ["10 WOMEN'S", 'Alabama Align 25" Pant', 'Women', { size: '10', gender: 'female', ageGroup: 'adult' }],
    ["2XL MEN'S", 'Alabama Hoodie', null, { size: '2XL', gender: 'male', ageGroup: 'adult' }],
    ['YOUTH MED', 'Alabama Jersey', 'Kids', { size: 'M', gender: null, ageGroup: 'kids' }],
    ['3T', 'Alabama Toddler Tee', null, { size: '3T', gender: null, ageGroup: 'toddler' }],
    ['YXL 16-18', 'Alabama Jersey', null, { size: 'YXL 16-18', gender: null, ageGroup: 'kids' }],
    ['LG', "Alabama Women's Script Tee", null, { size: 'L', gender: 'female', ageGroup: 'adult' }],
    ['OSFA', 'Alabama Cap', 'Caps, Hats, & Beanies', { size: 'One Size', gender: null, ageGroup: null }],
    [null, 'Alabama Gift Bag', 'Desk & Stationery', { size: null, gender: null, ageGroup: null }],
  ] as const)('%s / %s', (label, title, category, expected) => {
    expect(apparelSizing(label, title, category)).toEqual(expected);
  });

  it('does not read MEN\'S out of WOMEN\'S', () => {
    expect(apparelSizing("SM WOMEN'S", 'Tee', null).gender).toBe('female');
  });
});
