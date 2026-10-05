import type { CatalogType, PlatformId } from '../core/model.ts';
import { dealeron } from './dealeron.ts';
import { jsonld } from './jsonld.ts';
import { prismrbs } from './prismrbs.ts';
import type { Adapter } from './types.ts';

const ADAPTERS: Record<PlatformId, Adapter> = { prismrbs, jsonld, dealeron };

export function adapterFor(platform: PlatformId): Adapter {
  return ADAPTERS[platform];
}

/** Most specific first: the generic JSON-LD reader is the fallback. */
export function detectPlatform(homepageHtml: string): PlatformId | null {
  if (prismrbs.detect(homepageHtml)) return 'prismrbs';
  if (dealeron.detect(homepageHtml)) return 'dealeron';
  if (jsonld.detect(homepageHtml)) return 'jsonld';
  return null;
}

export function catalogTypeOf(platform: PlatformId): CatalogType {
  return ADAPTERS[platform].catalogType;
}
