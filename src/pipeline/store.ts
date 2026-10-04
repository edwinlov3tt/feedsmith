// All D1 access. Rows are parsed on the way out (sites through
// SiteConfigSchema, variants through VariantSchema), never cast.
//
// D1 allows 100 bound parameters per statement, so multi-row writes are
// chunked to stay under it.

import { z } from 'zod';
import type { Change } from '../core/diff.ts';
import { VariantSchema, type ProductRef, type Variant } from '../core/model.ts';
import { PlatformSchema, SiteConfigSchema, type Site } from '../core/site.ts';

const MAX_PARAMS = 100;

export const now = (): string => new Date().toISOString();

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs statements in D1 batches (each batch is one transaction). */
async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const group of chunk(statements, 50)) if (group.length) await db.batch(group);
}

// ---------- sites ----------

const SiteRow = z.object({
  id: z.string(),
  name: z.string(),
  base_url: z.string(),
  platform: PlatformSchema,
  config_json: z.string(),
  meta_catalog_id: z.string().nullable(),
  meta_token_enc: z.string().nullable(),
  last_discovery_count: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface SiteRecord extends Site {
  hasMetaToken: boolean;
  createdAt: string;
  updatedAt: string;
}

function toSite(raw: unknown): SiteRecord {
  const row = SiteRow.parse(raw);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    platform: row.platform,
    config: SiteConfigSchema.parse(JSON.parse(row.config_json)),
    metaCatalogId: row.meta_catalog_id,
    lastDiscoveryCount: row.last_discovery_count,
    hasMetaToken: row.meta_token_enc !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SITE_COLUMNS = 'id, name, base_url, platform, config_json, meta_catalog_id, meta_token_enc, last_discovery_count, created_at, updated_at';

export async function getSite(db: D1Database, id: string): Promise<SiteRecord | null> {
  const row = await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?`).bind(id).first();
  return row ? toSite(row) : null;
}

/** Every valid site. A row that fails to parse is logged and skipped so one bad config can't stop cron for all sites. */
export async function listSites(db: D1Database): Promise<SiteRecord[]> {
  const { results } = await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY id`).all();
  const sites: SiteRecord[] = [];
  for (const raw of results) {
    try {
      sites.push(toSite(raw));
    } catch (err) {
      console.error(JSON.stringify({ event: 'invalid_site_row', message: err instanceof Error ? err.message : String(err) }));
    }
  }
  return sites;
}

export async function insertSite(db: D1Database, site: Site, feedPasswordHash: string): Promise<void> {
  const ts = now();
  await db
    .prepare('INSERT INTO sites (id, name, base_url, platform, config_json, feed_password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(site.id, site.name, site.baseUrl, site.platform, JSON.stringify(site.config), feedPasswordHash, ts, ts)
    .run();
}

export async function updateSiteBasics(db: D1Database, id: string, name: string, config: Site['config']): Promise<void> {
  await db.prepare('UPDATE sites SET name = ?, config_json = ?, updated_at = ? WHERE id = ?').bind(name, JSON.stringify(config), now(), id).run();
}

export async function setFeedPasswordHash(db: D1Database, id: string, hash: string): Promise<void> {
  await db.prepare('UPDATE sites SET feed_password_hash = ?, updated_at = ? WHERE id = ?').bind(hash, now(), id).run();
}

export async function getFeedPasswordHash(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare('SELECT feed_password_hash AS h FROM sites WHERE id = ?').bind(id).first();
  return z.object({ h: z.string() }).nullable().parse(row)?.h ?? null;
}

export async function setMetaCredentials(db: D1Database, id: string, catalogId: string | null, tokenEnc: string | null): Promise<void> {
  await db.prepare('UPDATE sites SET meta_catalog_id = ?, meta_token_enc = ?, updated_at = ? WHERE id = ?').bind(catalogId, tokenEnc, now(), id).run();
}

export async function getMetaTokenEnc(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare('SELECT meta_token_enc AS t FROM sites WHERE id = ?').bind(id).first();
  return z.object({ t: z.string().nullable() }).nullable().parse(row)?.t ?? null;
}

export async function setLastDiscoveryCount(db: D1Database, id: string, count: number): Promise<void> {
  await db.prepare('UPDATE sites SET last_discovery_count = ? WHERE id = ?').bind(count, id).run();
}

// ---------- runs ----------

export const RUN_STATUSES = ['discovering', 'crawling', 'finalizing', 'published', 'rejected', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunMode = 'full' | 'sweep';
const ACTIVE_STATUSES: readonly RunStatus[] = ['discovering', 'crawling', 'finalizing'];

const RunRow = z.object({
  id: z.string(),
  site_id: z.string(),
  mode: z.enum(['full', 'sweep']),
  status: z.enum(RUN_STATUSES),
  total: z.number(),
  discovered: z.number().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  error: z.string().nullable(),
  notes_json: z.string(),
});

export interface Run {
  id: string;
  siteId: string;
  mode: RunMode;
  status: RunStatus;
  total: number;
  discovered: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  notes: Record<string, unknown>;
}

function toRun(raw: unknown): Run {
  const r = RunRow.parse(raw);
  const notes: unknown = JSON.parse(r.notes_json);
  return {
    id: r.id,
    siteId: r.site_id,
    mode: r.mode,
    status: r.status,
    total: r.total,
    discovered: r.discovered,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    notes: z.record(z.string(), z.unknown()).catch({}).parse(notes),
  };
}

/** Creates a run, or returns null when the site already has one in progress (enforced by a unique index). */
export async function createRun(db: D1Database, siteId: string, mode: RunMode, status: RunStatus): Promise<Run | null> {
  const id = crypto.randomUUID();
  try {
    await db.prepare('INSERT INTO runs (id, site_id, mode, status, started_at) VALUES (?, ?, ?, ?, ?)').bind(id, siteId, mode, status, now()).run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return null;
    throw err;
  }
  const run = await getRun(db, id);
  if (!run) throw new Error('run vanished after insert');
  return run;
}

export async function getRun(db: D1Database, id: string): Promise<Run | null> {
  const row = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  return row ? toRun(row) : null;
}

export async function listRuns(db: D1Database, siteId: string, limit: number): Promise<Run[]> {
  const { results } = await db.prepare('SELECT * FROM runs WHERE site_id = ? ORDER BY started_at DESC LIMIT ?').bind(siteId, limit).all();
  return results.map(toRun);
}

/** A run still in progress for the site, if one started within `maxAgeMs`. */
export async function activeRun(db: D1Database, siteId: string, maxAgeMs: number): Promise<Run | null> {
  const since = new Date(Date.now() - maxAgeMs).toISOString();
  const row = await db
    .prepare(`SELECT * FROM runs WHERE site_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND started_at > ? ORDER BY started_at DESC LIMIT 1`)
    .bind(siteId, ...ACTIVE_STATUSES, since)
    .first();
  return row ? toRun(row) : null;
}

/** Marks runs stuck in progress for longer than `maxAgeMs` as failed. */
export async function failStaleRuns(db: D1Database, maxAgeMs: number): Promise<number> {
  const before = new Date(Date.now() - maxAgeMs).toISOString();
  const res = await db
    .prepare(`UPDATE runs SET status = 'failed', error = 'timed out', finished_at = ? WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND started_at <= ?`)
    .bind(now(), ...ACTIVE_STATUSES, before)
    .run();
  return res.meta.changes;
}

export async function startCrawling(db: D1Database, runId: string, total: number, discovered: number | null, notes: Record<string, unknown>): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = 'crawling', total = ?, discovered = ?, notes_json = ? WHERE id = ?")
    .bind(total, discovered, JSON.stringify(notes), runId)
    .run();
}

/** Moves crawling -> finalizing exactly once, however many consumers race here. */
export async function claimFinalize(db: D1Database, runId: string): Promise<boolean> {
  const res = await db.prepare("UPDATE runs SET status = 'finalizing' WHERE id = ? AND status = 'crawling'").bind(runId).run();
  return res.meta.changes === 1;
}

/**
 * Lets one finalize message own the run. Redeliveries of that message (same
 * queue message ID) may proceed; any other finalize message for the run may not.
 */
export async function claimFinalizeMessage(db: D1Database, runId: string, messageId: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE runs SET finalize_msg_id = ? WHERE id = ? AND status = 'finalizing' AND (finalize_msg_id IS NULL OR finalize_msg_id = ?)")
    .bind(messageId, runId, messageId)
    .run();
  return res.meta.changes === 1;
}

export async function finishRun(db: D1Database, runId: string, status: RunStatus, error: string | null, notes: Record<string, unknown>): Promise<void> {
  await db
    .prepare('UPDATE runs SET status = ?, error = ?, notes_json = ?, finished_at = ? WHERE id = ?')
    .bind(status, error, JSON.stringify(notes), now(), runId)
    .run();
}

// ---------- run items ----------

export type Outcome = 'ok' | 'gone' | 'not_product' | 'error';

export async function recordOutcomes(db: D1Database, runId: string, outcomes: Array<{ key: string; outcome: Outcome; message: string | null }>): Promise<void> {
  const rows = chunk(outcomes, Math.floor(MAX_PARAMS / 4));
  await runBatched(
    db,
    rows.map((group) =>
      db
        .prepare(`INSERT OR IGNORE INTO run_items (run_id, ref_key, outcome, message) VALUES ${group.map(() => '(?, ?, ?, ?)').join(',')}`)
        .bind(...group.flatMap((o) => [runId, o.key, o.outcome, o.message?.slice(0, 500) ?? null])),
    ),
  );
}

export interface OutcomeCounts {
  ok: number;
  gone: number;
  not_product: number;
  error: number;
  processed: number;
}

export async function outcomeCounts(db: D1Database, runId: string): Promise<OutcomeCounts> {
  const { results } = await db.prepare('SELECT outcome, COUNT(*) AS n FROM run_items WHERE run_id = ? GROUP BY outcome').bind(runId).all();
  const counts: OutcomeCounts = { ok: 0, gone: 0, not_product: 0, error: 0, processed: 0 };
  for (const raw of results) {
    const r = z.object({ outcome: z.enum(['ok', 'gone', 'not_product', 'error']), n: z.number() }).parse(raw);
    counts[r.outcome] = r.n;
    counts.processed += r.n;
  }
  return counts;
}

export async function keysWithOutcome(db: D1Database, runId: string, outcome: Outcome): Promise<string[]> {
  const { results } = await db.prepare('SELECT ref_key FROM run_items WHERE run_id = ? AND outcome = ?').bind(runId, outcome).all();
  return results.map((raw) => z.object({ ref_key: z.string() }).parse(raw).ref_key);
}

export async function sampleErrors(db: D1Database, runId: string, limit: number): Promise<Array<{ key: string; message: string | null }>> {
  const { results } = await db.prepare("SELECT ref_key, message FROM run_items WHERE run_id = ? AND outcome = 'error' LIMIT ?").bind(runId, limit).all();
  return results.map((raw) => {
    const r = z.object({ ref_key: z.string(), message: z.string().nullable() }).parse(raw);
    return { key: r.ref_key, message: r.message };
  });
}

/** Keeps per-product outcomes for the latest `keep` runs of a site. */
export async function pruneRunItems(db: D1Database, siteId: string, keep: number): Promise<void> {
  await db
    .prepare('DELETE FROM run_items WHERE run_id IN (SELECT id FROM runs WHERE site_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?)')
    .bind(siteId, keep)
    .run();
}

// ---------- products ----------

const ProductRow = z.object({
  ref_key: z.string(),
  url: z.string(),
  category: z.string().nullable(),
  department: z.string().nullable(),
  clearance: z.number(),
  featured: z.number(),
});
const PRODUCT_COLUMNS = 'ref_key, url, category, department, clearance, featured';

function toRef(raw: unknown): ProductRef {
  const r = ProductRow.parse(raw);
  return { key: r.ref_key, url: r.url, category: r.category, department: r.department, clearance: r.clearance === 1, featured: r.featured === 1 };
}

/** Records discovered products; anything discovered is active again. */
export async function upsertDiscovered(db: D1Database, siteId: string, runId: string, refs: readonly ProductRef[]): Promise<void> {
  const ts = now();
  const rows = chunk(refs, Math.floor(MAX_PARAMS / 9));
  await runBatched(
    db,
    rows.map((group) =>
      db
        .prepare(
          `INSERT INTO products (site_id, ref_key, url, category, department, clearance, featured, status, last_discovered_run_id, missing_full_runs, updated_at) VALUES ${group
            .map(() => "(?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?)")
            .join(',')}
           ON CONFLICT (site_id, ref_key) DO UPDATE SET url = excluded.url, category = excluded.category,
             department = excluded.department, clearance = excluded.clearance, featured = excluded.featured,
             status = CASE WHEN products.status = 'not_product' THEN 'not_product' ELSE 'active' END,
             last_discovered_run_id = excluded.last_discovered_run_id, missing_full_runs = 0, updated_at = excluded.updated_at`,
        )
        .bind(...group.flatMap((r) => [siteId, r.key, r.url, r.category, r.department, r.clearance ? 1 : 0, r.featured ? 1 : 0, runId, ts])),
    ),
  );
}

/** Products recorded by a given full run's discovery, for re-enqueueing after a redelivery. */
export async function refsDiscoveredIn(db: D1Database, siteId: string, runId: string): Promise<ProductRef[]> {
  const { results } = await db
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE site_id = ? AND last_discovered_run_id = ? ORDER BY ref_key`)
    .bind(siteId, runId)
    .all();
  return results.map(toRef);
}

/** Products a sweep should re-read. */
export async function activeRefs(db: D1Database, siteId: string, limit: number): Promise<ProductRef[]> {
  const { results } = await db
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE site_id = ? AND status = 'active' ORDER BY ref_key LIMIT ?`)
    .bind(siteId, limit)
    .all();
  return results.map(toRef);
}

export async function setProductStatus(db: D1Database, siteId: string, keys: readonly string[], status: 'active' | 'gone' | 'not_product'): Promise<void> {
  const ts = now();
  await runBatched(
    db,
    chunk(keys, MAX_PARAMS - 3).map((group) =>
      db
        .prepare(`UPDATE products SET status = ?, updated_at = ? WHERE site_id = ? AND ref_key IN (${group.map(() => '?').join(',')})`)
        .bind(status, ts, siteId, ...group),
    ),
  );
}

/**
 * After a full run that passed its gates: products not discovered this time
 * get a strike; two strikes in a row and they are treated as gone. Returns the
 * keys that just became gone.
 */
export async function strikeUndiscovered(db: D1Database, siteId: string, runId: string): Promise<number> {
  // struck_run_id makes this a no-op when finalize is redelivered.
  await db
    .prepare(
      `UPDATE products SET missing_full_runs = missing_full_runs + 1, struck_run_id = ?
       WHERE site_id = ? AND status = 'active' AND (last_discovered_run_id IS NULL OR last_discovered_run_id != ?)
         AND (struck_run_id IS NULL OR struck_run_id != ?)`,
    )
    .bind(runId, siteId, runId, runId)
    .run();
  const res = await db
    .prepare("UPDATE products SET status = 'gone', updated_at = ? WHERE site_id = ? AND status = 'active' AND missing_full_runs >= 2")
    .bind(now(), siteId)
    .run();
  return res.meta.changes;
}

/**
 * Gone products that still have sellable variants. Expiry works from this
 * state rather than from the moment a product turned gone, so an interrupted
 * finalize catches up on its retry.
 */
export async function goneWithStock(db: D1Database, siteId: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT p.ref_key FROM products p JOIN variants v ON v.site_id = p.site_id AND v.ref_key = p.ref_key
       WHERE p.site_id = ? AND p.status = 'gone' AND v.availability NOT IN ('out of stock', 'discontinued') LIMIT ?`,
    )
    .bind(siteId, limit)
    .all();
  return results.map((raw) => z.object({ ref_key: z.string() }).parse(raw).ref_key);
}

// ---------- variants and changes ----------

/** Parses a stored variant; a corrupt row is logged and skipped, never allowed to stop a whole feed. */
function parseVariant(dataJson: string, where: string): Variant | null {
  let raw: unknown;
  try {
    raw = JSON.parse(dataJson);
  } catch {
    raw = null;
  }
  const parsed = VariantSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error(JSON.stringify({ event: 'invalid_variant_row', where, issue: parsed.error?.issues[0]?.message ?? 'not JSON' }));
  return null;
}

export async function variantsForRef(db: D1Database, siteId: string, refKey: string): Promise<Variant[]> {
  const { results } = await db.prepare('SELECT data_json FROM variants WHERE site_id = ? AND ref_key = ?').bind(siteId, refKey).all();
  return results.map((raw) => parseVariant(z.object({ data_json: z.string() }).parse(raw).data_json, refKey)).filter((v): v is Variant => v !== null);
}

/** Which product currently owns each SKU. Stores can list one SKU under several products. */
export async function variantOwners(db: D1Database, siteId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const group of chunk(ids, MAX_PARAMS - 1)) {
    const { results } = await db
      .prepare(`SELECT id, ref_key FROM variants WHERE site_id = ? AND id IN (${group.map(() => '?').join(',')})`)
      .bind(siteId, ...group)
      .all();
    for (const raw of results) {
      const r = z.object({ id: z.string(), ref_key: z.string() }).parse(raw);
      owners.set(r.id, r.ref_key);
    }
  }
  return owners;
}

/** Writes a product's variant changes and change log in one transaction. */
export function variantWrites(db: D1Database, siteId: string, runId: string, refKey: string, upserts: readonly Variant[], changes: readonly Change[]): D1PreparedStatement[] {
  const ts = now();
  const out: D1PreparedStatement[] = [];
  for (const v of upserts) {
    out.push(
      db
        .prepare(
          `INSERT INTO variants (site_id, id, ref_key, data_json, availability, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id, id) DO UPDATE SET ref_key = excluded.ref_key, data_json = excluded.data_json, availability = excluded.availability, updated_at = excluded.updated_at`,
        )
        .bind(siteId, v.id, refKey, JSON.stringify(v), v.availability, ts, ts),
    );
  }
  for (const group of chunk(changes, Math.floor(MAX_PARAMS / 6))) {
    out.push(
      db
        .prepare(`INSERT INTO changes (site_id, run_id, variant_id, kind, fields, created_at) VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}`)
        .bind(...group.flatMap((c) => [siteId, runId, c.variantId, c.kind, c.fields.join(','), ts])),
    );
  }
  return out;
}

/** One product's writes as a single transaction, so variants and their change rows commit together. */
export async function applyWrites(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length) await db.batch(statements);
}

/** Pages through every variant of a site, ordered by id. */
export async function* allVariants(db: D1Database, siteId: string, pageSize = 500): AsyncGenerator<Variant[]> {
  let after = '';
  for (;;) {
    const { results } = await db
      .prepare('SELECT id, data_json FROM variants WHERE site_id = ? AND id > ? ORDER BY id LIMIT ?')
      .bind(siteId, after, pageSize)
      .all();
    if (results.length === 0) return;
    const rows = results.map((raw) => z.object({ id: z.string(), data_json: z.string() }).parse(raw));
    yield rows.map((r) => parseVariant(r.data_json, r.id)).filter((v): v is Variant => v !== null);
    const last = rows[rows.length - 1];
    if (!last || results.length < pageSize) return;
    after = last.id;
  }
}

const ChangeRow = z.object({
  id: z.number(),
  run_id: z.string(),
  variant_id: z.string(),
  kind: z.string(),
  fields: z.string(),
  created_at: z.string(),
  pushed_at: z.string().nullable(),
});

export async function listChanges(db: D1Database, siteId: string, limit: number): Promise<Array<z.infer<typeof ChangeRow>>> {
  const { results } = await db.prepare('SELECT id, run_id, variant_id, kind, fields, created_at, pushed_at FROM changes WHERE site_id = ? ORDER BY id DESC LIMIT ?').bind(siteId, limit).all();
  return results.map((raw) => ChangeRow.parse(raw));
}

/** Variants with changes Meta hasn't received yet, current state, oldest change first. */
export async function unpushed(db: D1Database, siteId: string, limit: number): Promise<{ changeIds: number[]; variants: Variant[] }> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS change_id, v.data_json FROM changes c JOIN variants v ON v.site_id = c.site_id AND v.id = c.variant_id
       WHERE c.site_id = ? AND c.pushed_at IS NULL ORDER BY c.id LIMIT ?`,
    )
    .bind(siteId, limit)
    .all();
  const changeIds: number[] = [];
  const byId = new Map<string, Variant>();
  for (const raw of results) {
    const r = z.object({ change_id: z.number(), data_json: z.string() }).parse(raw);
    changeIds.push(r.change_id);
    const v = parseVariant(r.data_json, `change ${r.change_id}`);
    if (v) byId.set(v.id, v);
  }
  return { changeIds, variants: [...byId.values()] };
}

export async function markPushed(db: D1Database, changeIds: readonly number[]): Promise<void> {
  const ts = now();
  await runBatched(
    db,
    chunk(changeIds, MAX_PARAMS - 1).map((group) =>
      db.prepare(`UPDATE changes SET pushed_at = ? WHERE id IN (${group.map(() => '?').join(',')})`).bind(ts, ...group),
    ),
  );
}

export async function soldOutInRun(db: D1Database, runId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(DISTINCT variant_id) AS n FROM changes WHERE run_id = ? AND kind = 'out_of_stock'").bind(runId).first();
  return z.object({ n: z.number() }).parse(row).n;
}

export async function sellableVariantCount(db: D1Database, siteId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM variants WHERE site_id = ? AND availability NOT IN ('out of stock', 'discontinued')").bind(siteId).first();
  return z.object({ n: z.number() }).parse(row).n;
}

export async function variantStats(db: D1Database, siteId: string): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT availability, COUNT(*) AS n FROM variants WHERE site_id = ? GROUP BY availability').bind(siteId).all();
  const out: Record<string, number> = {};
  for (const raw of results) {
    const r = z.object({ availability: z.string(), n: z.number() }).parse(raw);
    out[r.availability] = r.n;
  }
  return out;
}
