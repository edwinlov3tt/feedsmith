import { describe, expect, it } from 'vitest';
import { clothingType } from '../src/core/classify.ts';

// Titles and categories are real ones from the Supply Store and uwyostore.com feeds.
const label = (title: string, category: string | null = null): string | null => clothingType(title, category)?.label ?? null;

describe('clothingType', () => {
  it.each([
    ['Alabama Crimson Tide Victory Falls T-Shirt', 'T-Shirts'],
    ['Gear® Wyoming Cowboys Arched Around ESTD 1886 Tee', 'T-Shirts'],
    ['Alabama Timeless Long Sleeve Tee With Pom Pom Print', 'T-Shirts'],
    ['MV Sport® Arched Wyoming with Wyoming Cowboys Laces Hoodie', 'Sweatshirts & Hoodies'],
    ['Champion® Bucking Horse Contrast Collar 1/4 Zip', 'Sweatshirts & Hoodies'],
    ['Bama Roll Tide 1636 Crew Sweat', 'Sweatshirts & Hoodies'],
    ['Hood University of Wyoming Club Swimming', 'Sweatshirts & Hoodies'],
    ['Alabama Campus Crop Crew With Wrapped Up Bow', 'Sweatshirts & Hoodies'],
    ['University Alabama Reverse French Terry Fleece Sweatpant', 'Pants & Leggings'],
    ['Alabama Script A Legacy Pique Polo Tall', 'Polos'],
    ['Alabama Crimson Tide Big Block Button Up', 'Shirts & Tops'],
    ['Alabama Script A Align High Rise 6" Short', 'Shorts'],
    ['Alabama Nike Script A Legend Short Sleeve', 'Shirts & Tops'],
    ['Alabama Script A Three Bars Mid Pro Trucker', 'Hats'],
    ['Range Leather Patch Trout with Mesh Back Cap', 'Hats'],
    ['Nike #18 Alabama Home Football Jersey', 'Jerseys'],
    ['Alabama Mosaic Bralette', 'Bras'],
    ['Colosseum® Bucking Horse Onesie with W Bib', 'Baby Clothing'],
    ['Colosseum® Toddler Cheer Set', 'Outfit Sets'],
    ['Gameday Social® Wyoming Carly Cardigan Sweater', 'Sweaters'],
    ['Alabama Gameday Script A Dotted Rain Boots', 'Footwear'],
    ['Alabama Mosaic Ladies\' Night Gown', 'Sleepwear'],
    ['Comfort Wash® Tee Arched Wyoming over Bucking Horse Tie-Dye with Bucking Horse on back', 'T-Shirts'],
  ])('%s is %s', (title, expected) => {
    expect(label(title)).toBe(expected);
  });

  it.each([
    'Alabama Roll Tide Sweatshirt Blanket',
    'Summit® Bucking Horse Hooded Blanket',
    'Alabama Crimson Tide Golf Tee Pack Of 40',
    'Neil Enterprises® 2 Pack Bucking Horse Golf Balls with Wyoming Tees',
    'Alabama Valve Stem Caps',
    'Alabama Logo Print Grosgrain Bow',
    'Alabama Jersey Fanband',
    'University Store® Beach Bag with Decals',
    'Alabama Coat Hanger',
    'Alabama Plush Bear in Jersey',
  ])('%s is not clothing', (title) => {
    expect(label(title)).toBeNull();
  });

  it('keeps graduation regalia and pet gear out', () => {
    expect(label('Bachelor Cap & Gown - Does Not Include Tassel')).toBeNull();
    expect(label('Choose a Masters Hood 3.1 - A&S')).toBeNull();
    expect(label('Grad Cap Companion')).toBeNull();
    expect(label('Alabama Dog Jersey')).toBeNull();
    expect(label('Alabama Bandana', 'Alabama Pets')).toBeNull();
    // "Pet" as a word in a design name is not pet gear.
    expect(label('Alabama Campus Pullover Teacher\'s Pet')).toBe('Sweatshirts & Hoodies');
  });

  it('trusts a category that names only non-garments over the title', () => {
    expect(label('Alabama Woolie Elephant With Script A Tshirt', 'Toys And Games')).toBeNull();
    expect(label('Alabama Campus Grande Mug', 'Caps, Hats, & Beanies')).toBeNull();
  });

  it('falls back to the store category when the title names no garment', () => {
    expect(label('Create A Kinder Planet Alabama', 'T-Shirts')).toBe('T-Shirts');
    expect(label('Champion® Arch Wyoming Over Pistol Pete Bar', 'Caps, Hats, & Beanies')).toBe('Hats');
    // Two labels, one Google category: the broader one.
    expect(label('CI Sport® Bucking Horse with US Flag Stripes', "Men's T-Shirts & Tops")).toBe('Shirts & Tops');
    // Categories that mix garment types say nothing.
    expect(label('Champion® Wyoming Split Color Reverse Weave', "Women's Sweatshirts & Jackets")).toBeNull();
    expect(label('Alabama Palisade Logo', 'Shorts, Skirts, Pants, Leggings')).toBeNull();
  });

  it('gives Google categories no deeper than three levels', () => {
    expect(clothingType('Alabama Script A Chill Out Snapback', null)?.google).toBe('Apparel & Accessories > Clothing Accessories > Hats');
    expect(clothingType('Alabama Script A Marled Cuff Beanie', null)?.google.split(' > ')).toHaveLength(3);
    expect(clothingType('Nike Air Max Verse Shoe', null)?.google).toBe('Apparel & Accessories > Shoes');
  });
});
