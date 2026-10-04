import { z } from 'zod';
import { PLATFORMS } from './model.ts';

// Per-site crawl settings. Stored as JSON on the site row and parsed with this
// schema every time it is read, so a bad row fails loudly instead of crawling
// with half a config.
const fields = {
  /** Brand used when the title doesn't name one (usually the store itself). */
  defaultBrand: z.string().trim().min(1).max(100).nullable(),
  /** Brand names to look for in product titles, e.g. ["Nike", "Columbia"]. */
  brandKeywords: z.array(z.string().trim().min(1).max(60)).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Parallel requests to the storefront. Keep low: these are small sites. */
  crawlConcurrency: z.number().int().min(1).max(6),
  /** Caps products per run. For trials and local development. */
  maxProducts: z.number().int().min(1).max(100_000).nullable(),
  /** PrismRBS: catalog IDs to skip (e.g. clearance or gift cards). */
  excludeCatalogIds: z.array(z.number().int().positive()).max(1000),
  /** Generic: only URLs whose path matches one of these regexes are read. */
  includeUrlPatterns: z.array(z.string().max(200)).max(50),
  excludeUrlPatterns: z.array(z.string().max(200)).max(50),
  /** Generic: sitemap URLs to read at most. */
  maxSitemapUrls: z.number().int().min(1).max(200_000),
  /** Publish gates: a run over these is rejected and the last good feed stays live. */
  maxErrorRate: z.number().min(0).max(1),
  minDiscoveryRatio: z.number().min(0).max(1),
  /** Share of read products the site reports as gone (404 or "not available"). */
  maxGoneRate: z.number().min(0).max(1),
  /** Share of the site's in-stock variants that may sell out in one run. */
  maxSoldOutRate: z.number().min(0).max(1),
  /** The new feed must keep at least this share of the last published feed's items. */
  minFeedRatio: z.number().min(0).max(1),
};

type ConfigValues = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> };

const DEFAULTS: ConfigValues = {
  defaultBrand: null,
  brandKeywords: [],
  currency: 'USD',
  crawlConcurrency: 2,
  maxProducts: null,
  excludeCatalogIds: [],
  includeUrlPatterns: [],
  excludeUrlPatterns: [],
  maxSitemapUrls: 20_000,
  maxErrorRate: 0.2,
  minDiscoveryRatio: 0.8,
  maxGoneRate: 0.1,
  maxSoldOutRate: 0.25,
  minFeedRatio: 0.8,
};

/** A partial update: only the keys sent. No defaults, so unsent settings are left alone. */
export const SiteConfigPatchSchema = z.object(fields).partial().strict();

/**
 * A complete config: missing keys take their defaults. (`??` is safe for the
 * nullable fields because their default is null too.)
 */
export const SiteConfigSchema = SiteConfigPatchSchema.transform(
  (p): ConfigValues => ({
    defaultBrand: p.defaultBrand ?? DEFAULTS.defaultBrand,
    brandKeywords: p.brandKeywords ?? DEFAULTS.brandKeywords,
    currency: p.currency ?? DEFAULTS.currency,
    crawlConcurrency: p.crawlConcurrency ?? DEFAULTS.crawlConcurrency,
    maxProducts: p.maxProducts ?? DEFAULTS.maxProducts,
    excludeCatalogIds: p.excludeCatalogIds ?? DEFAULTS.excludeCatalogIds,
    includeUrlPatterns: p.includeUrlPatterns ?? DEFAULTS.includeUrlPatterns,
    excludeUrlPatterns: p.excludeUrlPatterns ?? DEFAULTS.excludeUrlPatterns,
    maxSitemapUrls: p.maxSitemapUrls ?? DEFAULTS.maxSitemapUrls,
    maxErrorRate: p.maxErrorRate ?? DEFAULTS.maxErrorRate,
    minDiscoveryRatio: p.minDiscoveryRatio ?? DEFAULTS.minDiscoveryRatio,
    maxGoneRate: p.maxGoneRate ?? DEFAULTS.maxGoneRate,
    maxSoldOutRate: p.maxSoldOutRate ?? DEFAULTS.maxSoldOutRate,
    minFeedRatio: p.minFeedRatio ?? DEFAULTS.minFeedRatio,
  }),
);

export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export const SiteIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'lowercase letters, digits and dashes, 3-50 chars');

export const PlatformSchema = z.enum(PLATFORMS);

export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  platform: z.infer<typeof PlatformSchema>;
  config: SiteConfig;
  metaCatalogId: string | null;
  lastDiscoveryCount: number | null;
}

/** Parses validated regexes once; invalid patterns are rejected at the API. */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
}

export function validatePatterns(patterns: readonly string[]): string | null {
  for (const p of patterns) {
    try {
      new RegExp(p, 'i');
    } catch {
      return `invalid pattern: ${p}`;
    }
  }
  return null;
}
