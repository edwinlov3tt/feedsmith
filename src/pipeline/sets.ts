// Product sets: stored per site, evaluated locally against the feed, and synced
// to the site's Meta catalog when one is connected.

import { decryptSecret } from '../core/crypto.ts';
import { csvHeader, csvLine, feedProblem, toFeedRow, type FeedRow } from '../core/feed.ts';
import type { CatalogType } from '../core/model.ts';
import { matchesSet, parseSetFilter, toMetaFilter, type SetFilter } from '../core/set-filter.ts';
import type { Site } from '../core/site.ts';
import { deleteProductSet, upsertProductSet, type MetaTarget, type SetSyncResult } from './meta.ts';
import { allVariants, getMetaTokenEnc, recordSetSync, type StoredSet } from './store.ts';

export interface SetDefinition {
  slug: string;
  name: string;
  filter: Record<string, unknown>;
}

/** Feed rows that would be published, in feed order. */
async function* publishableRows(db: D1Database, siteId: string): AsyncGenerator<FeedRow> {
  for await (const page of allVariants(db, siteId)) {
    for (const v of page) if (feedProblem(v) === null) yield toFeedRow(v);
  }
}

/** The row's item id, in either catalog's column naming. */
const rowId = (row: FeedRow): string => row['id'] ?? row['vehicle_id'] ?? '';

/** Parsed filter for a stored set; a corrupt stored filter matches nothing. */
export function storedFilter(set: StoredSet, type: CatalogType): SetFilter | null {
  const parsed = parseSetFilter(set.filter, type);
  return parsed.ok ? parsed.filter : null;
}

/** Item counts for every set in one pass over the feed. */
export async function countSets(db: D1Database, siteId: string, type: CatalogType, sets: readonly StoredSet[]): Promise<Map<string, number>> {
  const filters = sets.map((s) => [s.slug, storedFilter(s, type)] as const);
  const counts = new Map(sets.map((s) => [s.slug, 0]));
  for await (const row of publishableRows(db, siteId)) {
    for (const [slug, f] of filters) if (f && matchesSet(f, row)) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

/** One page of a set's items, ordered by item id, starting after `after`. */
export async function setItems(db: D1Database, siteId: string, filter: SetFilter, limit: number, after: string | null): Promise<{ items: FeedRow[]; next: string | null }> {
  const items: FeedRow[] = [];
  for await (const row of publishableRows(db, siteId)) {
    if (after !== null && rowId(row) <= after) continue;
    if (!matchesSet(filter, row)) continue;
    if (items.length === limit) {
      const last = items[items.length - 1];
      return { items, next: last ? rowId(last) : null };
    }
    items.push(row);
  }
  return { items, next: null };
}

export async function setCsv(db: D1Database, siteId: string, type: CatalogType, filter: SetFilter): Promise<{ body: string; items: number }> {
  const parts = [csvHeader(type)];
  let items = 0;
  for await (const row of publishableRows(db, siteId)) {
    if (!matchesSet(filter, row)) continue;
    parts.push(csvLine(row, type));
    items++;
  }
  return { body: parts.join(''), items };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * The recommended sets for a site, built from the labels actually present in
 * its feed (docs/product-sets.md): a default prospecting set, one per
 * department, Women's, Kids and Clearance. Sets with no items are left out,
 * since Meta won't deliver ads from an empty set.
 */
export async function defaultSetDefinitions(db: D1Database, siteId: string, type: CatalogType): Promise<SetDefinition[]> {
  if (type === 'vehicles') return defaultVehicleSets(db, siteId);
  const departments = new Map<string, number>();
  let women = 0;
  let kids = 0;
  let clearance = 0;
  for await (const row of publishableRows(db, siteId)) {
    const dept = row['custom_label_0'];
    if (dept) departments.set(dept, (departments.get(dept) ?? 0) + 1);
    if (row['gender'] === 'female') women++;
    if (['kids', 'toddler', 'infant', 'newborn'].includes(row['age_group'] ?? '')) kids++;
    if (row['custom_label_1'] === 'clearance') clearance++;
  }
  const defs: SetDefinition[] = [
    {
      slug: 'all-in-stock',
      name: 'All in stock (excluding clearance)',
      filter: { and: [{ availability: { eq: 'in stock' } }, { custom_label_1: { neq: 'clearance' } }] },
    },
  ];
  for (const [dept, n] of [...departments].sort((a, b) => b[1] - a[1])) {
    if (n > 0) defs.push({ slug: `dept-${slugify(dept)}`, name: dept, filter: { custom_label_0: { eq: dept } } });
  }
  if (women > 0) defs.push({ slug: 'womens', name: "Women's", filter: { gender: { eq: 'female' } } });
  if (kids > 0) defs.push({ slug: 'kids', name: 'Kids', filter: { age_group: { is_any: ['kids', 'toddler', 'infant', 'newborn'] } } });
  if (clearance > 0) defs.push({ slug: 'clearance', name: 'Clearance', filter: { custom_label_1: { eq: 'clearance' } } });
  return defs;
}

/**
 * Vehicle defaults: everything available, by condition (New / Used / CPO), and
 * by the body styles that make up most dealer inventory. Empty sets are skipped.
 */
async function defaultVehicleSets(db: D1Database, siteId: string): Promise<SetDefinition[]> {
  const count = new Map<string, number>();
  const bump = (k: string): void => {
    count.set(k, (count.get(k) ?? 0) + 1);
  };
  for await (const row of publishableRows(db, siteId)) {
    if (row['availability'] !== 'available') continue;
    bump(`state:${row['state_of_vehicle']}`);
    bump(`body:${row['body_style']}`);
  }
  const available = { availability: { eq: 'available' } };
  const candidates: Array<SetDefinition & { needs: string[] }> = [
    { slug: 'all-available', name: 'All available vehicles', filter: available, needs: [] },
    { slug: 'new', name: 'New vehicles', filter: { and: [available, { state_of_vehicle: { eq: 'New' } }] }, needs: ['state:New'] },
    { slug: 'used', name: 'Used vehicles', filter: { and: [available, { state_of_vehicle: { is_any: ['Used', 'CPO'] } }] }, needs: ['state:Used', 'state:CPO'] },
    { slug: 'cpo', name: 'Certified pre-owned', filter: { and: [available, { state_of_vehicle: { eq: 'CPO' } }] }, needs: ['state:CPO'] },
    { slug: 'trucks', name: 'Trucks', filter: { and: [available, { body_style: { eq: 'TRUCK' } }] }, needs: ['body:TRUCK'] },
    { slug: 'suvs', name: 'SUVs and crossovers', filter: { and: [available, { body_style: { is_any: ['SUV', 'CROSSOVER'] } }] }, needs: ['body:SUV', 'body:CROSSOVER'] },
    { slug: 'cars', name: 'Cars', filter: { and: [available, { body_style: { is_any: ['SEDAN', 'COUPE', 'HATCHBACK', 'CONVERTIBLE', 'WAGON', 'SMALL_CAR'] } }] }, needs: ['body:SEDAN', 'body:COUPE', 'body:HATCHBACK', 'body:CONVERTIBLE', 'body:WAGON', 'body:SMALL_CAR'] },
  ];
  return candidates
    .filter((c) => c.needs.length === 0 || c.needs.some((n) => (count.get(n) ?? 0) > 0))
    .map(({ slug, name, filter }) => ({ slug, name, filter }));
}

export async function metaTargetFor(env: Env, site: Pick<Site, 'id' | 'metaCatalogId'>): Promise<MetaTarget | null> {
  if (!site.metaCatalogId) return null;
  const enc = await getMetaTokenEnc(env.DB, site.id);
  if (!enc) return null;
  return { catalogId: site.metaCatalogId, token: await decryptSecret(enc, env.TOKEN_ENC_KEY), graphVersion: env.META_GRAPH_VERSION };
}

export type SyncOutcome = { slug: string; ok: true; result: SetSyncResult } | { slug: string; ok: false; error: string };

/** Pushes one stored set to Meta and records the outcome on the set. */
export async function syncSet(env: Env, siteId: string, type: CatalogType, target: MetaTarget, set: StoredSet): Promise<SyncOutcome> {
  const filter = storedFilter(set, type);
  if (!filter) {
    await recordSetSync(env.DB, siteId, set.slug, null, 'stored filter is invalid');
    return { slug: set.slug, ok: false, error: 'stored filter is invalid' };
  }
  try {
    const result = await upsertProductSet(target, { slug: set.slug, name: set.name, filter: toMetaFilter(filter), metaSetId: set.metaSetId });
    await recordSetSync(env.DB, siteId, set.slug, result.metaSetId, null);
    return { slug: set.slug, ok: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordSetSync(env.DB, siteId, set.slug, null, error);
    return { slug: set.slug, ok: false, error };
  }
}

export async function unsyncSet(target: MetaTarget, set: StoredSet): Promise<void> {
  if (set.metaSetId) await deleteProductSet(target, set.metaSetId);
}
