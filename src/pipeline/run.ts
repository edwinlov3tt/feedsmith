// Crawl orchestration over Cloudflare Queues.
//
//   start  -> (full)  discover message -> product refs -> read messages (5 refs each)
//          -> (sweep) read messages for known active products
//   read   -> fetch + parse + validate + diff + write, one outcome row per product
//   last read to finish claims the run and sends one finalize message
//   finalize -> publish gates -> expire gone products -> feed to R2 -> Meta push
//
// Every step is safe to redeliver: outcomes are keyed (run, product), the
// finalize claim is a conditional UPDATE keyed by queue message ID, strikes are
// recorded per run, expiry works from current state, and the Meta push sends
// current state rather than deltas. Messages that exhaust their retries land
// in the dead-letter queue, whose handler records them as errors so the run
// still reaches finalize and the error gate decides.

import { z } from 'zod';
import { adapterFor } from '../adapters/registry.ts';
import { decryptSecret } from '../core/crypto.ts';
import { diffProduct } from '../core/diff.ts';
import { HttpClient, mapLimit, siteHosts } from '../core/http.ts';
import { ProductRefSchema, VariantSchema, type ProductRef, type Variant } from '../core/model.ts';
import type { Site } from '../core/site.ts';
import { pushVariants } from './meta.ts';
import { buildFeed, publishedItems, writeFeed } from './publish.ts';
import {
  activeRefs,
  activeRun,
  applyWrites,
  claimFinalize,
  claimFinalizeMessage,
  createRun,
  failStaleRuns,
  finishRun,
  getMetaTokenEnc,
  getRun,
  getSite,
  goneWithStock,
  keysWithOutcome,
  markPushed,
  outcomeCounts,
  pruneRunItems,
  recordOutcomes,
  refsDiscoveredIn,
  sampleErrors,
  sellableVariantCount,
  setLastDiscoveryCount,
  setProductStatus,
  soldOutInRun,
  startCrawling,
  strikeUndiscovered,
  unpushed,
  upsertDiscovered,
  variantOwners,
  variantsForRef,
  variantWrites,
  type Outcome,
  type OutcomeCounts,
  type Run,
  type RunMode,
} from './store.ts';

const REFS_PER_MESSAGE = 5;
export const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_SWEEP_PRODUCTS = 50_000;
const PUSH_LIMIT = 10_000;
const EXPIRE_PER_FINALIZE = 500;

export const CrawlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discover'), runId: z.uuid(), siteId: z.string() }),
  z.object({ type: z.literal('read'), runId: z.uuid(), siteId: z.string(), refs: z.array(ProductRefSchema).min(1).max(REFS_PER_MESSAGE) }),
  z.object({ type: z.literal('finalize'), runId: z.uuid(), siteId: z.string() }),
]);
export type CrawlMessage = z.infer<typeof CrawlMessageSchema>;

type OutcomeRow = { key: string; outcome: Outcome; message: string | null };

export function httpFor(site: Site, env: Env): HttpClient {
  return new HttpClient({ allowedHosts: siteHosts(site.baseUrl), userAgent: env.USER_AGENT });
}

async function enqueueReads(env: Env, runId: string, siteId: string, refs: readonly ProductRef[]): Promise<void> {
  const messages: Array<{ body: CrawlMessage }> = [];
  for (let i = 0; i < refs.length; i += REFS_PER_MESSAGE) {
    messages.push({ body: { type: 'read', runId, siteId, refs: refs.slice(i, i + REFS_PER_MESSAGE) } });
  }
  // sendBatch takes at most 100 messages per call.
  for (let i = 0; i < messages.length; i += 100) await env.CRAWL.sendBatch(messages.slice(i, i + 100));
}

export type StartResult = { kind: 'started'; run: Run } | { kind: 'busy'; run: Run | null } | { kind: 'no_site' };

export async function startRun(env: Env, siteId: string, requested: RunMode): Promise<StartResult> {
  const site = await getSite(env.DB, siteId);
  if (!site) return { kind: 'no_site' };
  // A run stuck past the age limit would otherwise block the site until cron clears it.
  await failStaleRuns(env.DB, RUN_MAX_AGE_MS);
  const existing = await activeRun(env.DB, siteId, RUN_MAX_AGE_MS);
  if (existing) return { kind: 'busy', run: existing };

  // A sweep needs known products; the first run of a site is always full.
  const refs = requested === 'sweep' ? await activeRefs(env.DB, siteId, MAX_SWEEP_PRODUCTS) : [];
  const mode: RunMode = requested === 'sweep' && refs.length > 0 ? 'sweep' : 'full';
  const run = await createRun(env.DB, siteId, mode, mode === 'full' ? 'discovering' : 'crawling');
  // Lost the race to another start: the unique index refused the second active run.
  if (!run) return { kind: 'busy', run: await activeRun(env.DB, siteId, RUN_MAX_AGE_MS) };
  try {
    if (mode === 'full') {
      await env.CRAWL.send({ type: 'discover', runId: run.id, siteId } satisfies CrawlMessage);
    } else {
      await startCrawling(env.DB, run.id, refs.length, null, { requestedMode: requested });
      await enqueueReads(env, run.id, siteId, refs);
    }
  } catch (err) {
    await finishRun(env.DB, run.id, 'failed', `could not enqueue: ${err instanceof Error ? err.message : String(err)}`, {});
    throw err;
  }
  return { kind: 'started', run: (await getRun(env.DB, run.id)) ?? run };
}

async function handleDiscover(env: Env, msg: Extract<CrawlMessage, { type: 'discover' }>): Promise<void> {
  const run = await getRun(env.DB, msg.runId);
  if (!run) return;
  // Redelivery after discovery already finished: re-send the reads (they're
  // idempotent) in case the earlier attempt failed partway through enqueueing.
  if (run.status === 'crawling' && run.mode === 'full') {
    const refs = await refsDiscoveredIn(env.DB, msg.siteId, run.id);
    if (refs.length) await enqueueReads(env, run.id, msg.siteId, refs);
    return;
  }
  if (run.status !== 'discovering') return;
  const site = await getSite(env.DB, msg.siteId);
  if (!site) return;
  const result = await adapterFor(site.platform).discover({ site, http: httpFor(site, env) });

  // Refs travel through the queue, whose schema they must satisfy; drop any that wouldn't.
  const refs = result.refs.filter((r) => ProductRefSchema.safeParse(r).success);
  const dropped = result.refs.length - refs.length;
  const warnings = dropped ? [`${dropped} product URLs dropped as invalid`, ...result.warnings] : result.warnings;
  if (refs.length === 0) {
    await finishRun(env.DB, run.id, 'failed', 'discovery found no products', { warnings, pagesFetched: result.pagesFetched });
    return;
  }
  await upsertDiscovered(env.DB, site.id, run.id, refs);
  await startCrawling(env.DB, run.id, refs.length, refs.length, {
    pagesFetched: result.pagesFetched,
    warnings,
    discoveryTruncated: result.truncated || dropped > 0,
  });
  await enqueueReads(env, run.id, site.id, refs);
}

async function readOne(env: Env, site: Site, run: Run, ref: ProductRef, http: HttpClient): Promise<OutcomeRow> {
  const result = await adapterFor(site.platform).read(ref, { site, http });
  switch (result.kind) {
    case 'ok': {
      // Validate before writing: a row that can't be parsed back would stall every later read of it.
      const valid: Variant[] = [];
      for (const v of result.variants) {
        const parsed = VariantSchema.safeParse(v);
        if (!parsed.success) {
          return { key: ref.key, outcome: 'error', message: `invalid variant ${v.id}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}` };
        }
        valid.push(parsed.data);
      }
      // A SKU listed under several products belongs to the lowest product key, so
      // ownership is stable and the SKU doesn't flip (and re-log) every run.
      const owners = await variantOwners(env.DB, site.id, valid.map((v) => v.id));
      const owned = valid.filter((v) => {
        const owner = owners.get(v.id);
        return owner === undefined || owner === ref.key || compareKeys(ref.key, owner) < 0;
      });
      const diff = diffProduct(await variantsForRef(env.DB, site.id, ref.key), owned);
      await applyWrites(env.DB, variantWrites(env.DB, site.id, run.id, ref.key, diff.upserts, diff.changes));
      await setProductStatus(env.DB, site.id, [ref.key], 'active');
      return { key: ref.key, outcome: 'ok', message: null };
    }
    case 'gone':
      // Nothing is written yet: the product is expired in finalize, and only if
      // the run passes its gates (a site-wide 404 must not sell out the catalog).
      return { key: ref.key, outcome: 'gone', message: result.reason };
    case 'not_product': {
      // A known product turning into a non-product page is more likely a bot
      // challenge or template change than a real change; treat it as unreadable.
      if ((await variantsForRef(env.DB, site.id, ref.key)).length > 0) {
        return { key: ref.key, outcome: 'error', message: 'known product page has no product data' };
      }
      await setProductStatus(env.DB, site.id, [ref.key], 'not_product');
      return { key: ref.key, outcome: 'not_product', message: null };
    }
    case 'error':
      // Nothing is written: a page we can't read never changes stock.
      return { key: ref.key, outcome: 'error', message: result.message };
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled read result ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Orders product keys numerically when both are numbers (PrismRBS pf_id), else as text. */
export function compareKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** After outcomes are recorded: the read that completes the run sends finalize. */
async function maybeFinalize(env: Env, run: Run): Promise<void> {
  const counts = await outcomeCounts(env.DB, run.id);
  if (counts.processed < run.total) return;
  // 'finalizing' here means an earlier attempt claimed the run but may have
  // failed to send; sending again is safe because finalize is claimed by message.
  if (run.status === 'finalizing' || (await claimFinalize(env.DB, run.id))) {
    await env.CRAWL.send({ type: 'finalize', runId: run.id, siteId: run.siteId } satisfies CrawlMessage);
  }
}

async function handleRead(env: Env, msg: Extract<CrawlMessage, { type: 'read' }>): Promise<void> {
  const run = await getRun(env.DB, msg.runId);
  if (!run || (run.status !== 'crawling' && run.status !== 'finalizing')) return;
  const site = await getSite(env.DB, msg.siteId);
  if (!site) return;
  if (run.status === 'crawling') {
    const http = httpFor(site, env);
    const outcomes = await mapLimit(msg.refs, site.config.crawlConcurrency, (ref) => readOne(env, site, run, ref, http));
    await recordOutcomes(env.DB, run.id, outcomes);
  }
  await maybeFinalize(env, run);
}

export interface GateInput {
  run: Pick<Run, 'mode' | 'total' | 'discovered'>;
  counts: Pick<OutcomeCounts, 'error' | 'gone' | 'processed'>;
  soldOut: number;
  /** In-stock variants before this run: sellable now plus those this run sold out. */
  sellableBefore: number;
}

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Decides whether a run's results are trustworthy enough to publish. */
export function evaluateGates(input: GateInput, site: Pick<Site, 'config' | 'lastDiscoveryCount'>): GateResult {
  const { run, counts, soldOut, sellableBefore } = input;
  const reasons: string[] = [];
  const errorRate = run.total > 0 ? counts.error / run.total : 1;
  if (errorRate > site.config.maxErrorRate) reasons.push(`error rate ${pct(errorRate)} exceeds ${pct(site.config.maxErrorRate)}`);
  const goneRate = run.total > 0 ? counts.gone / run.total : 0;
  if (goneRate > site.config.maxGoneRate) reasons.push(`${pct(goneRate)} of products reported gone, over ${pct(site.config.maxGoneRate)}`);
  const soldOutRate = sellableBefore > 0 ? soldOut / sellableBefore : 0;
  if (soldOutRate > site.config.maxSoldOutRate) reasons.push(`${pct(soldOutRate)} of in-stock variants sold out in one run, over ${pct(site.config.maxSoldOutRate)}`);
  if (run.mode === 'full' && site.lastDiscoveryCount !== null && run.discovered !== null) {
    const ratio = site.lastDiscoveryCount > 0 ? run.discovered / site.lastDiscoveryCount : 1;
    if (ratio < site.config.minDiscoveryRatio) {
      reasons.push(`discovered ${run.discovered} products, ${(ratio * 100).toFixed(0)}% of last run's ${site.lastDiscoveryCount}`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/** Marks every sellable variant of gone products out of stock, from current state. */
async function expireGone(env: Env, site: Site, runId: string): Promise<{ products: number; changes: number; more: boolean }> {
  const keys = await goneWithStock(env.DB, site.id, EXPIRE_PER_FINALIZE);
  let changes = 0;
  for (const key of keys) {
    const diff = diffProduct(await variantsForRef(env.DB, site.id, key), 'gone');
    await applyWrites(env.DB, variantWrites(env.DB, site.id, runId, key, diff.upserts, diff.changes));
    changes += diff.changes.length;
  }
  return { products: keys.length, changes, more: keys.length === EXPIRE_PER_FINALIZE };
}

async function pushToMeta(env: Env, site: Site): Promise<Record<string, unknown>> {
  if (!site.metaCatalogId) return { skipped: 'no Meta catalog configured' };
  const tokenEnc = await getMetaTokenEnc(env.DB, site.id);
  if (!tokenEnc) return { skipped: 'no Meta token configured' };
  const { changeIds, variants } = await unpushed(env.DB, site.id, PUSH_LIMIT);
  if (changeIds.length === 0) return { sent: 0 };
  const token = await decryptSecret(tokenEnc, env.TOKEN_ENC_KEY);
  const result = await pushVariants({ catalogId: site.metaCatalogId, token, graphVersion: env.META_GRAPH_VERSION }, variants);
  await markPushed(env.DB, changeIds);
  return {
    sent: result.sent,
    changes: changeIds.length,
    handles: result.handles.slice(0, 20),
    rejected: result.rejected.length,
    rejectedSample: result.rejected.slice(0, 20),
    warnings: result.warnings,
  };
}

async function handleFinalize(env: Env, msg: Extract<CrawlMessage, { type: 'finalize' }>, messageId: string): Promise<void> {
  const run = await getRun(env.DB, msg.runId);
  if (!run || run.status !== 'finalizing') return;
  if (!(await claimFinalizeMessage(env.DB, run.id, messageId))) return;
  const site = await getSite(env.DB, msg.siteId);
  if (!site) return;
  const counts = await outcomeCounts(env.DB, run.id);
  const soldOut = await soldOutInRun(env.DB, run.id);
  const sellableBefore = (await sellableVariantCount(env.DB, site.id)) + soldOut;
  const gates = evaluateGates({ run, counts, soldOut, sellableBefore }, site);
  const notes: Record<string, unknown> = { ...run.notes, counts, soldOut, gates };

  if (!gates.passed) {
    notes['errorsSample'] = await sampleErrors(env.DB, run.id, 20);
    await finishRun(env.DB, run.id, 'rejected', gates.reasons.join('; '), notes);
    return;
  }
  // Products the site reported gone this run, now that the run is trusted.
  const goneKeys = await keysWithOutcome(env.DB, run.id, 'gone');
  if (goneKeys.length) await setProductStatus(env.DB, site.id, goneKeys, 'gone');
  if (run.mode === 'full') {
    // Truncated discovery can't tell "vanished" from "not reached".
    if (run.notes['discoveryTruncated'] !== true) notes['struckProducts'] = await strikeUndiscovered(env.DB, site.id, run.id);
    if (run.discovered !== null) await setLastDiscoveryCount(env.DB, site.id, run.discovered);
  }
  notes['expired'] = await expireGone(env, site, run.id);

  // Last check before anything leaves: the feed itself must not collapse. This
  // catches what per-product checks can't, such as a config change that makes
  // most items unpublishable.
  const feed = await buildFeed(env.DB, site.id);
  const previous = await publishedItems(env.FEEDS, site.id);
  if (previous !== null && previous > 0 && feed.items < previous * site.config.minFeedRatio) {
    const reason = `feed would shrink from ${previous} to ${feed.items} items (${pct(feed.items / previous)} of the live feed, under ${pct(site.config.minFeedRatio)})`;
    notes['feed'] = { rejected: reason, items: feed.items, skipped: feed.skipped };
    await finishRun(env.DB, run.id, 'rejected', reason, notes);
    return;
  }
  notes['feed'] = await writeFeed(env.FEEDS, site.id, run.id, feed);
  try {
    notes['meta'] = await pushToMeta(env, site);
  } catch (err) {
    // The feed is already live; the unpushed changes go out with the next run.
    notes['meta'] = { error: err instanceof Error ? err.message : String(err) };
  }
  if (counts.error > 0) notes['errorsSample'] = await sampleErrors(env.DB, run.id, 20);
  await finishRun(env.DB, run.id, 'published', null, notes);
  await pruneRunItems(env.DB, site.id, 10);
}

export async function handleMessage(env: Env, body: unknown, messageId: string): Promise<void> {
  const parsed = CrawlMessageSchema.safeParse(body);
  if (!parsed.success) {
    // A malformed message can never succeed on retry; log and drop it.
    console.error(JSON.stringify({ event: 'malformed_message', issue: parsed.error.issues[0]?.message }));
    return;
  }
  const msg = parsed.data;
  switch (msg.type) {
    case 'discover':
      return handleDiscover(env, msg);
    case 'read':
      return handleRead(env, msg);
    case 'finalize':
      return handleFinalize(env, msg, messageId);
    default: {
      const unreachable: never = msg;
      throw new Error(`unhandled message ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A message that exhausted its retries. Record it so the run can still finish. */
export async function handleDeadLetter(env: Env, body: unknown): Promise<void> {
  const parsed = CrawlMessageSchema.safeParse(body);
  if (!parsed.success) return;
  const msg = parsed.data;
  const run = await getRun(env.DB, msg.runId);
  if (!run) return;
  switch (msg.type) {
    case 'read':
      if (run.status !== 'crawling' && run.status !== 'finalizing') return;
      if (run.status === 'crawling') {
        await recordOutcomes(env.DB, run.id, msg.refs.map((r) => ({ key: r.key, outcome: 'error' as const, message: 'dead-lettered after retries' })));
      }
      await maybeFinalize(env, run);
      return;
    case 'discover':
    case 'finalize':
      if (run.status === 'discovering' || run.status === 'finalizing') {
        await finishRun(env.DB, run.id, 'failed', `${msg.type} failed after retries`, run.notes);
      }
      return;
    default: {
      const unreachable: never = msg;
      throw new Error(`unhandled message ${JSON.stringify(unreachable)}`);
    }
  }
}
