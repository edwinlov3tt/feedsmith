import { escapeRegExp } from './html.ts';

/** First brand keyword that appears as a whole word in the title, else the default. */
export function pickBrand(title: string, keywords: readonly string[], fallback: string | null): string | null {
  for (const k of keywords) {
    if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}([^a-z0-9]|$)`, 'i').test(title)) return k;
  }
  return fallback;
}

const SIZE_TOKEN =
  /^(xxs|xs|sm|s|small|med|m|medium|lg|l|large|xl|xxl|xxxl|[2-6]x|[2-6]xl|os|osfa|one size|youth|toddler|infant|\d+(\.\d+)?[a-z]?|\d+\/\d+|\d+t|\d+m)$/i;

/** True when a variant label reads like a size ("SM UNISEX", "2XL", "10 WOMEN'S", "32x30"). */
export function looksLikeSize(label: string): boolean {
  const first = label.trim().split(/\s+/)[0] ?? '';
  return SIZE_TOKEN.test(first) || /^\d+\s*x\s*\d+$/i.test(label.trim());
}

/** Pulls size/color out of named attributes, matching on the attribute name. */
export function sizeAndColor(attributes: Record<string, string>): { size: string | null; color: string | null } {
  let size: string | null = null;
  let color: string | null = null;
  for (const [name, value] of Object.entries(attributes)) {
    if (size === null && /size/i.test(name)) size = value;
    else if (color === null && /colou?r/i.test(name)) color = value;
  }
  return { size, color };
}

/** Meta limits: title 200 chars, description 9,999. Cut on a word boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export const GENDERS = ['female', 'male', 'unisex'] as const;
export type Gender = (typeof GENDERS)[number];
export const AGE_GROUPS = ['adult', 'all ages', 'teen', 'kids', 'toddler', 'infant', 'newborn'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

const SIZE_WORDS: Record<string, string> = {
  SM: 'S',
  SMALL: 'S',
  MED: 'M',
  MEDIUM: 'M',
  LG: 'L',
  LARGE: 'L',
  XLG: 'XL',
  OSFA: 'One Size',
  OSFM: 'One Size',
  OS: 'One Size',
};

function genderIn(text: string): Gender | null {
  // WOMEN'S contains MEN'S, so women is checked first.
  if (/\b(WOMEN'?S?|WOMENS|LADIES|LADY|GIRLS?)\b/i.test(text)) return 'female';
  if (/\b(MEN'?S?|MENS|BOYS?)\b/i.test(text)) return 'male';
  if (/\bUNISEX\b/i.test(text)) return 'unisex';
  return null;
}

function ageIn(text: string): AgeGroup | null {
  if (/\b(NEWBORN|NB)\b/i.test(text)) return 'newborn';
  if (/\b(INFANT|BABY|\d{1,2}\s?-\s?\d{1,2}\s?M(O|OS|ONTHS?)?)\b/i.test(text)) return 'infant';
  if (/\b(TODDLER|[2-5]T)\b/i.test(text)) return 'toddler';
  // Youth sizes: YXS, YSM, YMED, YLG, YXL (e.g. "YXL 16-18").
  if (/\b(YOUTH|KIDS?|BOYS?|GIRLS?|CHILD(REN)?|Y(XS|SM|S|MED|M|LG|L|XL))\b/i.test(text)) return 'kids';
  return null;
}

export interface Sizing {
  size: string | null;
  gender: Gender | null;
  ageGroup: AgeGroup | null;
}

/**
 * Splits store size labels like "SM UNISEX", "10 WOMEN'S" or "YOUTH MED" into
 * Meta's separate size / gender / age_group fields. The label wins; the title
 * and category fill in what the label doesn't say.
 */
export function apparelSizing(sizeLabel: string | null, title: string, category: string | null): Sizing {
  const label = sizeLabel?.trim() ?? '';
  const context = `${title} ${category ?? ''}`;
  const gender = genderIn(label) ?? genderIn(context);
  const ageGroup = ageIn(label) ?? ageIn(context) ?? (gender ? 'adult' : null);
  if (!label) return { size: null, gender, ageGroup };
  const cleaned = label
    .replace(/\b(WOMEN'?S?|WOMENS|LADIES|MEN'?S?|MENS|UNISEX|YOUTH|KIDS?|BOYS?|GIRLS?|TODDLER|INFANT|ADULT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const size = cleaned ? (SIZE_WORDS[cleaned.toUpperCase()] ?? cleaned) : label;
  return { size, gender, ageGroup };
}
