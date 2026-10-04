import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiteConfigSchema, type Site } from '../src/core/site.ts';

export function fixture(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
}

export function testSite(overrides: Partial<Site> = {}, config: Record<string, unknown> = {}): Site {
  return {
    id: 'supe',
    name: 'University of Alabama Supply Store',
    baseUrl: 'https://www.universitysupplystore.com/',
    platform: 'prismrbs',
    config: SiteConfigSchema.parse({
      defaultBrand: 'University of Alabama Supply Store',
      brandKeywords: ['Nike', 'Columbia', 'Comfort Colors', 'JnJ Apparel'],
      ...config,
    }),
    metaCatalogId: null,
    lastDiscoveryCount: null,
    ...overrides,
  };
}
