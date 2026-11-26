// Clothing type for product sets, from the product's own words. Fixed rules, no
// model: the same title always gets the same answer, and a wrong answer is
// fixed by editing a rule here.
//
// Two outputs: a short label (custom_label_4, e.g. "T-Shirts") for sets by
// garment, and a Google product category, which Meta, TikTok, Google and
// Pinterest all accept. Google paths stop at three levels because TikTok reads
// no deeper; every path here is in Google's taxonomy (version 2021-09-21).

export interface ClothingType {
  /** custom_label_4, e.g. "T-Shirts". */
  label: string;
  /** Google product category path. */
  google: string;
}

const SHIRTS = 'Apparel & Accessories > Clothing > Shirts & Tops';
const GOOGLE = {
  shirts: SHIRTS,
  outerwear: 'Apparel & Accessories > Clothing > Outerwear',
  shorts: 'Apparel & Accessories > Clothing > Shorts',
  pants: 'Apparel & Accessories > Clothing > Pants',
  dresses: 'Apparel & Accessories > Clothing > Dresses',
  skirts: 'Apparel & Accessories > Clothing > Skirts',
  skorts: 'Apparel & Accessories > Clothing > Skorts',
  onePieces: 'Apparel & Accessories > Clothing > One-Pieces',
  baby: 'Apparel & Accessories > Clothing > Baby & Toddler Clothing',
  outfitSets: 'Apparel & Accessories > Clothing > Outfit Sets',
  socks: 'Apparel & Accessories > Clothing > Underwear & Socks',
  sleepwear: 'Apparel & Accessories > Clothing > Sleepwear & Loungewear',
  hats: 'Apparel & Accessories > Clothing Accessories > Hats',
  scarves: 'Apparel & Accessories > Clothing Accessories > Scarves & Shawls',
  gloves: 'Apparel & Accessories > Clothing Accessories > Gloves & Mittens',
  bandanas: 'Apparel & Accessories > Clothing Accessories > Bandanas & Headties',
  shoes: 'Apparel & Accessories > Shoes',
} as const;

interface Rule {
  pattern: RegExp;
  /** null: the word names something that isn't clothing. */
  type: ClothingType | null;
}

const kind = (label: string, google: string): ClothingType => ({ label, google });

// Order breaks ties between matches that end at the same word ("T-Shirt" also
// ends in "Shirt"), so specific rules come before general ones.
const RULES: Rule[] = [
  // Not garments, though they end in a garment word.
  { pattern: /\b(golf tees?|valve stem caps?|smarty pants|spout tops?|lab coats?)\b/gi, type: null },
  { pattern: /\b(t-?shirts?|tee ?shirts?|tees?)\b/gi, type: kind('T-Shirts', GOOGLE.shirts) },
  { pattern: /\bsweatpants?\b/gi, type: kind('Pants & Leggings', GOOGLE.pants) },
  {
    pattern: /\b(sweat ?shirts?|sweats?|hood(ie|ies|ed|y)?|crew ?necks?|crews?|pullovers?|quarter[- ]zips?|1\/4[- ]zips?|half[- ]zips?|1\/2[- ]zips?|full[- ]zips?|zip[- ]?ups?|fleece)\b/gi,
    type: kind('Sweatshirts & Hoodies', GOOGLE.shirts),
  },
  { pattern: /\b(sweaters?|cardigans?|turtlenecks?)\b/gi, type: kind('Sweaters', GOOGLE.shirts) },
  { pattern: /\bpolos?\b/gi, type: kind('Polos', GOOGLE.shirts) },
  { pattern: /\bjerseys?\b/gi, type: kind('Jerseys', GOOGLE.shirts) },
  { pattern: /\b(jackets?|windbreakers?|vests?|anoraks?|coats?|parkas?|puffers?|ponchos?|bombers?|windshirts?|windshells?|shackets?)\b/gi, type: kind('Jackets & Outerwear', GOOGLE.outerwear) },
  { pattern: /\b(shirts?|tops?|tanks?|button[- ]?(ups?|downs?)|henleys?|blouses?|tunics?|mock ?necks?|mocks?|crops?|corsets?|flannels?|sleeveless|long ?sleeves?|short ?sleeves?)\b/gi, type: kind('Shirts & Tops', GOOGLE.shirts) },
  { pattern: /\b(sweat)?shorts?\b(?![- ]?sleeves?)/gi, type: kind('Shorts', GOOGLE.shorts) },
  { pattern: /\b(pants?|joggers?|leggings?|tights?|trousers)\b/gi, type: kind('Pants & Leggings', GOOGLE.pants) },
  { pattern: /\bdress(es)?\b/gi, type: kind('Dresses & Skirts', GOOGLE.dresses) },
  { pattern: /\bskorts?\b/gi, type: kind('Dresses & Skirts', GOOGLE.skorts) },
  { pattern: /\bskirts?\b/gi, type: kind('Dresses & Skirts', GOOGLE.skirts) },
  { pattern: /\b(bras?|bralettes?)\b/gi, type: kind('Bras', GOOGLE.socks) },
  { pattern: /\b(nightshirts?|night ?gowns?|pajamas?|pjs?|loungewear)\b/gi, type: kind('Sleepwear', GOOGLE.sleepwear) },
  { pattern: /\b(onesies?|bodysuits?|creepers?)\b/gi, type: kind('Baby Clothing', GOOGLE.baby) },
  { pattern: /\b(rompers?|jumpsuits?|jumpers?|overalls)\b/gi, type: kind('One-Pieces', GOOGLE.onePieces) },
  { pattern: /\b(cheer|football|basketball|baseball|softball|infant|toddler|baby) sets?\b/gi, type: kind('Outfit Sets', GOOGLE.outfitSets) },
  { pattern: /\bsocks?\b/gi, type: kind('Socks', GOOGLE.socks) },
  { pattern: /\b(caps?|hats?|beanies?|visors?|snapbacks?|truckers?|toboggans?)\b/gi, type: kind('Hats', GOOGLE.hats) },
  { pattern: /\b(scarf|scarves)\b/gi, type: kind('Scarves', GOOGLE.scarves) },
  { pattern: /\b(gloves?|mittens?)\b/gi, type: kind('Gloves', GOOGLE.gloves) },
  { pattern: /\bbandanas?\b/gi, type: kind('Bandanas', GOOGLE.bandanas) },
  { pattern: /\b(shoes?|sneakers?|slides|sandals?|flip[- ]?flops?|slippers?|boots?)\b/gi, type: kind('Footwear', GOOGLE.shoes) },
  // Things that carry a garment word but aren't worn: "Sweatshirt Blanket",
  // "Hat Decal", "Jersey Ornament", "Mini Helmet".
  {
    pattern:
      /\b(decals?|stickers?|magnets?|mugs?|tumblers?|cups?|glass(es|ware)?|koozies?|coozies?|coolies?|clips?|fanbands?|ornaments?|pins?|buttons?(?![- ]?(ups?|downs?)\b)|keychains?|key ?rings?|lanyards?|frames?|flags?|banners?|pennants?|signs?|blankets?|throws?|pillows?|towels?|plush|toys?|puzzles?|books?|notebooks?|cards?|posters?|coasters?|bottles?|figurines?|bobbleheads?|helmets?|balls?|hangers?|umbrellas?|candles?|trays?|bags?|totes?|backpacks?|wallets?|purses?|tattoos?|bibs?|burp cloths?|pom ?poms|crossbody|crowns?|watch ?bands?|earrings?|necklaces?|bracelets?|jewelry|bows?|tassels?|ties?(?![- ]?dye)|masks?)\b/gi,
    type: null,
  },
];

// Graduation regalia ("Masters Hood", "Cap & Gown") and pet gear ("Dog Jersey")
// name garments they aren't.
const NOT_APPAREL =
  /\b(?<!night ?)(gowns?|regalia|stoles?)\b|\bgrad(uation)? caps?\b|\b(master'?s|masters|doctoral|bachelor'?s|bachelors|phd)\b.*\bhoods?\b|\b(dogs?|cats?|pets?) (collars?|leash(es)?|toys?|bowls?|beds?|tags?|jerseys?|tees?|t-shirts?|shirts?|bandanas?|harness(es)?|sweaters?|hoodies?)\b|\bfor (dogs|cats|pets)\b/i;
const PET_CATEGORY = /\bpets?\b/i;

/** The rule whose match ends last: in a product name the garment comes last ("Helmet Tee"). */
function lastMatch(text: string): Rule | null {
  let best: Rule | null = null;
  let bestEnd = -1;
  // Earlier rules win ties, so only a strictly later end replaces the best.
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const end = m.index + m[0].length;
      if (end > bestEnd) {
        best = rule;
        bestEnd = end;
      }
    }
  }
  return best;
}

function categoryParts(category: string): string[] {
  return category.split(/,|&|\band\b/i).map((p) => p.trim()).filter(Boolean);
}

/** True when every named thing in the category is a non-garment. */
function categoryIsNotClothing(category: string): boolean {
  const rules = categoryParts(category).map((p) => lastMatch(p)).filter((r) => r !== null);
  return rules.length > 0 && rules.every((r) => r.type === null);
}

/** The type a store category name gives, or null when its parts disagree. */
function categoryType(category: string): ClothingType | null {
  // Parts that name nothing ("Men & Women") don't count.
  const rules = categoryParts(category).map((p) => lastMatch(p)).filter((r) => r !== null);
  const types = rules.map((r) => r.type);
  if (types.length === 0 || types.some((t) => t === null)) return null;
  // "Caps, Hats, & Beanies" all say Hats; "Shorts, Skirts, Pants" don't agree.
  if (new Set(types.map((t) => t?.label)).size === 1) return types[0] ?? null;
  // "Men's T-Shirts & Tops" names two labels with one Google category: keep the broader, last one.
  return new Set(types.map((t) => t?.google)).size === 1 ? (types[types.length - 1] ?? null) : null;
}

/**
 * The clothing type of a product, or null when it isn't clothing or the words
 * don't say. The title decides; the store category is a fallback for titles
 * without a garment word ("Big AL Cheer Crew" has one, "Align 25in Pant" too).
 */
export function clothingType(title: string, category: string | null): ClothingType | null {
  if (NOT_APPAREL.test(title) || (category && (NOT_APPAREL.test(category) || PET_CATEGORY.test(category)))) return null;
  // A category that names only non-garments ("Toys And Games", "Cups, Mugs, &
  // Drinkware") outranks the title: "Woolie Elephant With Script A Tshirt" is a toy.
  if (category && categoryIsNotClothing(category)) return null;
  // "X with Y" (or "X in Y"): X is the product and Y its decoration. "Golf
  // Balls with Wyoming Tees" is golf balls and "Plush Bear in Jersey" a toy;
  // "Onesie with W Bib" and "Crop Crew With Wrapped Up Bow" are clothing.
  const head = title.split(/\s(?:with|w\/|in)\s/i)[0] ?? title;
  const headRule = head !== title ? lastMatch(head) : null;
  if (headRule && headRule.type === null) return null;
  const rule = lastMatch(title);
  if (rule?.type) return rule.type;
  if (headRule) return headRule.type;
  // A non-garment with nothing before "with" ("Bucking Horse with US Flag
  // Stripes") leaves it to the store category.
  if (rule && head === title) return null;
  return category ? categoryType(category) : null;
}
