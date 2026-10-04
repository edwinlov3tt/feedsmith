import { describe, expect, it } from 'vitest';
import { SiteConfigPatchSchema, SiteConfigSchema } from '../src/core/site.ts';

describe('site config', () => {
  it('fills defaults for a new site', () => {
    const c = SiteConfigSchema.parse({});
    expect(c).toMatchObject({ defaultBrand: null, currency: 'USD', crawlConcurrency: 2, maxErrorRate: 0.2, minFeedRatio: 0.8 });
  });

  it('a patch carries only the keys that were sent', () => {
    expect(SiteConfigPatchSchema.parse({ maxProducts: null })).toEqual({ maxProducts: null });
  });

  it('merging a patch keeps every other setting (regression: PATCH once reset the brand)', () => {
    const current = SiteConfigSchema.parse({ defaultBrand: 'Supply Store', brandKeywords: ['Nike'], maxProducts: 40 });
    const merged = SiteConfigSchema.parse({ ...current, ...SiteConfigPatchSchema.parse({ maxProducts: null }) });
    expect(merged).toMatchObject({ defaultBrand: 'Supply Store', brandKeywords: ['Nike'], maxProducts: null });
  });

  it('rejects unknown keys', () => {
    expect(() => SiteConfigPatchSchema.parse({ maxProduct: 1 })).toThrow();
  });
});
